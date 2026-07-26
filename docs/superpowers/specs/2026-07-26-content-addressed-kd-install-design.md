# Content-addressed kd installation

**Status:** Proposed

## Problem

The repository entrypoints `./kd` and `tools/kd/bin/kd-mcp` currently build
`tools/kd/dist` when the output is absent or older than the source. That
mtime check avoids repeated builds within one checkout, but `dist` is ignored
and therefore absent from every fresh Kanna worktree.

Kanna creates a fresh worktree at each pipeline transition. A group of tasks
created from the same commit consequently runs the same `tsup` build once per
workspace even though the `kd` inputs are identical. Besides wasting setup
time, these concurrent builds launch native build tools and contribute to the
executable-validation pressure that can make macOS `syspolicyd` pathological.

## Decision

`kd` will install immutable, content-addressed bundles in the user's Kanna
cache and share them across all worktrees:

```text
~/Library/Caches/kanna/tools/kd/<input-hash>/
```

The checked-in `kd` and `kd-mcp` entrypoints remain thin, repo-aware
launchers. They select the bundle whose hash matches the current checkout and
execute it with the caller's original working directory and environment.
Repository context, worktree ports, databases, daemon directories, and tmux
sessions remain private to the invoking workspace. Only executable JavaScript
is shared.

The first invocation for a new input hash builds and atomically installs both
entrypoints. Every checkout with the same inputs reuses that installation.
Committed and uncommitted source changes produce a different hash and
therefore a different installation.

## Alternatives considered

### Commit `tools/kd/dist`

Checking in the bundle would make every worktree immediately runnable, but it
would add generated JavaScript and source maps to reviews and require every
source edit to regenerate them correctly. A stale committed bundle would also
be easy to ship accidentally.

### Use one mutable global installation

A conventional global `kd` command is simple, but concurrent worktrees can
contain different versions of `kd`. Updating one global location would make
the most recent installer win and could run code from one branch while the
user is operating in another.

### Share one checkout's `dist`

Reusing the main checkout's artifact would avoid some builds, but it couples
open tasks to the lifetime, dependencies, and current revision of that
checkout. It also fails when a task intentionally changes `kd`.

Content-addressed installations avoid generated files in Git and allow
multiple revisions to run concurrently without mutable cross-worktree state.

## Launcher architecture

Both shell entrypoints delegate installation and selection to one checked-in
Node resolver. The resolver receives the requested entrypoint (`kd` or
`kd-mcp`) and:

1. resolves the repository and `tools/kd` roots from its own checked-in path;
2. computes the input identity;
3. checks the corresponding immutable cache entry;
4. coordinates installation when the entry is missing;
5. prints only the validated cached entrypoint path to stdout.

The shell entrypoint captures that path and uses `exec node` to run it with
the original arguments. Resolver diagnostics use stderr, so `kd-mcp` never
leaks installation output onto its JSON-RPC stdout. Keeping the selection
logic in one resolver prevents `kd` and `kd-mcp` from acquiring
different cache, invalidation, or locking behavior. The root `./kd` symlink
and `.mcp.json` command remain unchanged.

The default cache location follows Kanna's existing tool-cache convention.
Tests may override the root with a dedicated `KANNA_KD_CACHE_ROOT`
environment variable. On non-macOS development hosts, the launcher uses
`$XDG_CACHE_HOME/kanna/tools/kd` when set and otherwise
`~/.cache/kanna/tools/kd`.

## Input identity

The launcher computes a SHA-256 digest over a versioned cache schema plus the
relative path and bytes of every build input, sorted by relative path. Inputs
are read from the working tree, not inferred only from `HEAD`, so dirty edits
invalidate the installation immediately.

The identity includes:

- every regular file beneath `tools/kd/src`;
- `tools/kd/package.json`;
- `tools/kd/tsconfig.json`;
- `tools/kd/tsup.config.ts`;
- the `tools/kd` importer and its resolved transitive dependency projection
  from `pnpm-lock.yaml`;
- the repository `pnpm-workspace.yaml`;
- the Node major version, operating system, and architecture; and
- an explicit launcher cache-schema version.

The dependency projection excludes unrelated workspace importers and package
snapshots, so changing a mobile or desktop dependency does not rebuild `kd`.
It includes the lockfile format and settings that affect the selected
snapshots. The resolver may parse this projection only after confirming
`tools/kd/node_modules` exists; the clean-clone bootstrap described below
runs first when it does not.

The checked-in shell launchers and Node resolver are not build inputs because they run
directly from the current checkout rather than from the bundle. Changes to
their selection behavior therefore take effect immediately. Any launcher
change that alters bundle compatibility must also increment the cache-schema
version.

Directory traversal rejects symlinks and non-regular files below the declared
source root. This makes the hashed byte set explicit and prevents an
out-of-tree target from silently affecting the identity.

## Self-contained bundle

The current `tsup` output leaves packages such as Zod, `smol-toml`, and the
MCP SDK external. That works while `dist` is adjacent to
`tools/kd/node_modules`, but a cached copy cannot resolve dependencies from a
worktree that may later be removed.

The installed bundle therefore includes all runtime package dependencies.
Only Node built-ins remain external. A cache entry contains the complete
output directory for both `bin/kd.js` and `bin/kd-mcp.js`, their shared
chunks, source maps, and a manifest recording:

- the cache schema;
- the full input hash;
- the Node major version, platform, and architecture; and
- the two expected entrypoint paths.

The launcher considers an entry usable only when the manifest and both
entrypoints agree with the requested identity. It does not rely only on the
directory name.

This installation changes no release architecture. `kd` remains a
development tool requiring the repository's supported Node and pnpm
toolchain; Kanna's signed application and release sidecars do not consume the
cache.

## Concurrent installation

A missing hash is coordinated with an atomically published lock file beside
the final cache entry. The resolver writes the complete owner record (PID,
random token, and start time) to a process-private candidate file, then uses
an exclusive hard link to publish it as `.<input-hash>.lock`. The public name
is therefore either absent or backed by a fully populated owner record, and
publication cannot replace another process's lock.

Older resolver versions published a lock directory before writing its
`owner.json`. For compatibility, the reader accepts both the current file and
legacy directory formats. An ownerless or malformed legacy lock is
quarantined only after two consecutive unchanged observations separated by a
poll. Renaming the legacy directory aside prevents a delayed legacy writer
from modifying the current file lock: its later `.<hash>.lock/owner.json`
write fails against a file or absent parent instead. A malformed current lock
file cannot be produced by the atomic publisher, so the same stable-observation
recovery safely handles damage or interrupted older implementations.

The lock owner:

1. creates a process-private temporary directory below the same cache root;
2. builds both entrypoints into that directory;
3. verifies the manifest and executes smoke checks for both entrypoints;
4. atomically renames the temporary directory to `<input-hash>`; and
5. removes its lock in a process-exit handler.

Other launchers requesting the same hash wait for the owner and then validate
the published entry. They do not start redundant builds. A waiter recovers a
well-formed lock only when its recorded owner is no longer alive. It never
removes a well-formed lock owned by a live process, and a bounded wait ends
with an actionable error rather than waiting forever.

Temporary directories and lock-candidate files are never executable cache
hits. A failed owner-record write removes its private candidate without ever
creating the public lock. A failed build removes its own temporary directory
and token-matched public lock, leaving a later invocation free to retry. If
another valid entry appears before publication, the builder discards its
temporary output and uses the winner.

An incomplete or malformed final entry is treated as corrupt. Under the same
per-hash lock, the launcher moves it aside within the cache root, rebuilds,
and removes the quarantined cache directory after successful publication.
No source or worktree path is deleted during recovery.

## Execution behavior

On a cache hit, launching `kd` performs only input hashing, manifest
validation, and a Node execution. It does not invoke pnpm, tsup, esbuild, or a
package installation.

On a cache miss, the launcher requires the worktree dependencies installed by
the repository's preceding `pnpm install` setup command. Direct use from a
clean clone retains the current convenience behavior: it bootstraps
dependencies before building when `tools/kd/node_modules` is absent.

The bundle must derive all repository behavior from the caller's working
directory or the repository root passed by the launcher. It must never treat
its cache directory as the project root. Existing commands such as
`./kd env sync`, `./kd dev up`, and `./kd test rust` therefore retain their
worktree-specific behavior.

`kd-mcp` uses the identical cached bundle and identity. MCP registration still
points at the checked-in launcher so a new agent session automatically selects
the version belonging to its own checkout.

## Cache lifetime

Automatic eviction is out of scope for the initial change. Installations are
immutable, relatively small, and safe to delete when not executing. Avoiding
concurrent eviction keeps the first implementation independent from usage
leases and process-lifetime tracking.

The cache layout and manifest leave room for a later explicit inspection or
pruning command. Existing `./kd clean --all` remains workspace-scoped and does
not remove shared installations.

## Failure behavior and observability

Installation failures are fatal for the requested `kd` invocation because
there is no valid executable to run. Errors identify the cache hash, cache
path, failed phase, and the underlying command failure without printing
secrets from the environment.

The launcher emits a short stderr message only for a cache miss, wait, stale
lock recovery, corrupt-entry recovery, or failure. Cache hits remain silent.
The miss message distinguishes “installing” from ordinary command execution
so setup diagnostics make unexpected rebuilds visible.

No fallback writes `tools/kd/dist`. Keeping a second mutable artifact path
would make cache behavior ambiguous and allow later mtime checks to reintroduce
per-worktree rebuilds.

## Verification

Launcher contract tests use isolated temporary repositories and cache roots.
They cover:

- a clean checkout installs a bundle and runs `kd`;
- `kd-mcp` reuses the bundle installed by `kd`;
- a second worktree with byte-identical inputs performs no build;
- a committed source change selects a new hash;
- an uncommitted source edit selects a new hash;
- lockfile and build-config changes select a new hash;
- concurrent cold launches result in one build and both callers succeed;
- a failed build leaves no usable entry and the next invocation retries;
- dead, ownerless, and malformed locks are recovered while a live owner lock
  is preserved;
- an owner-record publication failure leaves no public lock or private
  candidate;
- malformed manifests and missing entrypoints are rebuilt safely;
- the cached bundle runs without adjacent `node_modules`;
- the cached command observes the invoking worktree's repository context;
- the cached MCP launcher completes `initialize` and `tools/list` with clean
  JSON-RPC stdout; and
- paths containing spaces are handled without shell interpolation.

Existing `tools/kd` unit tests, type checking, and the repository setup
contract remain part of verification. A manual canary creates two clean
worktrees from the same commit, runs `./kd --help` concurrently, and confirms
one installation message, one cache directory, and successful output from
both worktrees.

## Success criteria

The change is successful when:

1. identical `kd` inputs build once across all worktrees;
2. any relevant committed or dirty source change selects a new installation;
3. parallel cold launches never publish a partial artifact or duplicate the
   build;
4. `kd` and `kd-mcp` remain pinned to the invoking checkout's version;
5. cached execution has no dependency on the worktree that produced it; and
6. fresh-worktree setup no longer runs tsup or esbuild when a matching
   installation already exists.
