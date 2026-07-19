# Default Kanache worktree cache

Status: approved design for implementation.

## Problem

Kanna keeps Cargo's `build-dir` private to each checkout because sharing one
mutable Cargo directory across worktrees previously produced silent stale
`.rmeta` reuse. That isolation is correct, but active worktrees collectively
consume roughly 94 GiB even though their sources and most Rust build outputs
are usually identical.

Kanache now provides a reviewed APFS copy-on-write warm operation for clean
worktrees at the exact same Git commit. It clones only declared, locked Cargo
layouts into a private destination, invalidates local/path-package state, and
removes final executables, sidecars, and Tauri staging. Kanna should use that
operation by default for development worktrees while preserving cold Cargo
builds as the correctness fallback.

This is a measured rollout, not a change to release architecture. Bazel remains
the only release build path.

## Goals

- Attempt a Kanache warm automatically for every new local Kanna worktree.
- Keep every destination Cargo tree private; never share mutable Cargo paths.
- Select only exact-`HEAD`, clean, compatible donors from the same repository.
- Preserve private final sidecars and Tauri `externalBin` staging.
- Fall back to the current cold build whenever caching is unavailable or
  refused.
- Seed future donors from bounded successful `kd` Rust workflows.
- Record enough local evidence to decide whether Kanache meets Kanna's
  `< 30 s` warm and `< 1 GiB` physical-growth targets.
- Provide an immediate environment-variable rollback.

## Non-goals

- Bazel release, signing, notarization, or packaging changes.
- Sharing one mutable Cargo build directory.
- Cross-commit or dirty-worktree reuse.
- A permanent cache worktree, cache daemon, or new Kanna database state.
- Automatically declaring a long-running `tauri dev` build successful.
- Garbage collection beyond Kanna's existing worktree teardown and a
  versioned, machine-global Kanache tool installation.

## Chosen architecture

The integration lives in `kd`, Kanna's existing development control plane.
`kd` will bootstrap and invoke an exact Kanache revision, discover donors with
Git, manage bounded manifest lifecycles, and expose status. The repository
setup config will call the warm command explicitly, making it default-on
without hiding worktree creation behavior inside Cargo configuration.

The initial pinned upstream is:

```text
repository: https://github.com/jemdiggity/kanache
revision:   6107c7b533a77a0c7c190b75c0284e7501c6edbf
```

Kanna will never resolve a floating branch, tag, or arbitrary `kanache` from
`PATH`.

## Components

### Versioned tool bootstrap

`kd` resolves the binary beneath:

```text
~/Library/Caches/kanna/tools/kanache/<revision>/bin/kanache
```

If absent, `kd` runs a locked `cargo install` from the pinned Git revision into
a process-private temporary root, verifies the resulting executable with
`kanache --version`, and atomically publishes the version directory. Concurrent
installers may duplicate compilation, but only a complete installation can win
publication. A failed bootstrap is a cache miss, not a failed Kanna setup.

This tool is development-only. It is not embedded in Kanna.app and is never
consulted by Bazel release commands.

### `kd rust-cache` commands

The public development surface is:

```text
./kd rust-cache warm
./kd rust-cache record --layouts sidecars|all
./kd rust-cache status
```

`warm` bootstraps Kanache, selects a donor, attempts publication, and reports a
hit or miss. `record --layouts sidecars` records the explicit-target layout;
`record --layouts all` records both host and explicit-target layouts. Automatic
callers choose the narrowest set known to have completed successfully. `status`
reports the pinned tool, enablement, current build-tree state, and recent local
events.

`KANNA_RUST_CACHE=off` disables bootstrap, warm, and record. Unset, `on`, and
`kanache` all mean enabled. Unknown values fail closed to disabled with a clear
warning rather than guessing.

### Worktree setup

`.kanna/config.json` will run:

```text
pnpm install
./kd env sync
./kd rust-cache warm
```

The warm command is idempotent. If `.build/cargo-build` already exists, it
reports a miss and does not remove or replace it. Manual checkouts that skip
Kanna setup retain today's behavior.

### Donor discovery and ranking

`kd` reads `git worktree list --porcelain` from the current repository and
filters candidates before invoking Kanache:

1. candidate is not the destination;
2. candidate resolves under the same Git common directory;
3. candidate has the exact destination `HEAD`;
4. candidate contains a Kanache manifest and success marker;
5. candidate is a real directory, not a symlinked path.

Kanache remains the final authority for repository identity, cleanliness,
toolchain, `Cargo.lock`, Rust flags, layouts, extra inputs, locks, topology, and
atomic publication. A `kd` prefilter is only an optimization.

Kanna development layouts are profile `dev` with:

- implicit host layout: `host`;
- explicit sidecar layout: the installed Rust host triple, currently
  `aarch64-apple-darwin` on supported development machines.

Candidates are ranked by reusable coverage: both layouts, host only, then
explicit sidecar only. Within the same coverage, the newest valid manifest is
tried first. `kd` attempts candidates until one succeeds or all refuse. Once a
warm succeeds, no second donor is combined with it.

Kanna records no extra inputs initially. All local and path packages plus
build-script-run fingerprints are conservatively invalidated by Kanache. If a
future ignored input can influence a retained registry unit, it must be added
explicitly before that build becomes eligible as a donor.

### Donor recording

Only bounded successful commands may create a success marker:

- `kd build sidecars` records the explicit-target `dev` layout after all
  sidecars build and stage successfully.
- `kd test rust` records both host and explicit-target `dev` layouts after the
  complete canonical Rust suite succeeds.

Recording is best-effort and requires a clean worktree. Dirty worktrees remain
valid build consumers but cannot become donors. If a Kanna-managed desktop
process is already running for the worktree, commands skip `all` recording
because Tauri may be mutating host Cargo state concurrently. Sidecar-only
recording is allowed only when the bounded sidecar workflow owns the
explicit-target builds; a generic sidecar command skips recording if another
explicit-target Cargo build is detected.

Before each bounded workflow, `kd` removes the prior Kanache success marker via
`manifest begin`. After success it calls `manifest record` immediately. If the
build fails, no new success marker is written. A record failure never changes
the build command's successful result; it is logged as a cache-record miss.

This lifecycle relies on Kanna's canonical-build rule: development Cargo
commands run through `kd`. A direct Cargo invocation cannot clear the marker and
is therefore outside the supported donor-recording contract. All `kd` paths
that mutate a declared layout must call `manifest begin` before spawning Cargo,
even when that path will not record afterward.

Long-running `kd dev up` consumes a warm tree but does not record host success.
Its initial bounded sidecar build may record only the explicit layout before
Tauri starts. Kanache's undeclared-layout pruning makes later host mutations
irrelevant to an explicit-only donor.

## Failure behavior

Caching is an optimization. These cases all print a concise reason and continue
with the existing private cold build:

- disabled environment setting;
- unsupported OS or filesystem;
- tool download/build failure;
- no exact-`HEAD` donor;
- dirty or incompatible donor/destination;
- missing, busy, or replaced Cargo lock;
- an existing destination build directory;
- any Kanache refusal or nonzero exit.

Kanache guarantees temp cleanup and atomic destination publication. `kd` will
not delete an existing build directory to force a cache hit. An unexpected
post-failure destination tree is treated as an error requiring user inspection,
not automatically removed.

## Observability

Every warm and record attempt emits a human-readable one-line result and
appends one JSON object to:

```text
~/Library/Caches/kanna/kanache/events.jsonl
```

Fields include timestamp, repository identity hash, commit, destination,
donor when selected, requested layouts, outcome, refusal category, wall time,
and APFS free-space delta measured around the operation. Logs contain local
paths but no source content, environment values, or file hashes.

`kd rust-cache status` shows enablement, pinned revision, binary path, current
manifest/layout summary, and the most recent events for the current repository.
Malformed historical event lines are ignored with a warning; they never affect
cache correctness.

## Testing

Unit tests cover:

- pinned binary path and bootstrap plan;
- enable/disable parsing;
- worktree porcelain parsing and exact-commit filtering;
- donor ranking for both/host/explicit layouts;
- existing-destination and no-donor cold fallbacks;
- event serialization and status filtering;
- bounded build lifecycle command ordering;
- release tasks never invoking the cache layer.

Integration tests use a fake Kanache executable and temporary Git worktrees to
verify hit, refusal, candidate fallback, no destination deletion, and record
behavior without downloading tools.

The Kanna-scale canary then uses the real pinned binary and records:

- donor logical size and file count;
- warm wall time and free-space delta;
- first `kd build sidecars` and first host Cargo build time;
- rebuilt registry versus local artifacts from Cargo JSON output where
  practical;
- immediate edit propagation;
- donor removal followed by no-op and edited builds.

Success for continuing the default rollout is a representative 7–9 GiB donor
warmed in under 30 seconds with under 1 GiB physical growth, zero stale output,
and no registry rebuild caused solely by relocation. Failure rolls back with
`KANNA_RUST_CACHE=off` while retaining the private per-worktree build layout.

## Rollout

1. Land the default-on `kd` integration and tests.
2. Seed a clean main Kanna checkout by running `./kd test rust` once.
3. Create two exact-`HEAD` worktrees through Kanna and capture warm/build
   evidence.
4. Keep default-on if the safety and resource targets pass.
5. If performance misses, disable by environment while deciding between
   per-profile lazy cloning and a permanent donor cache. Never fall back to a
   shared mutable Cargo directory.
