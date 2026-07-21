# Default-on Kanache worktree cache

**Status:** Enabled by default for local macOS development after the
representative Kanna-scale canary passed the rollout gates below. CI,
non-macOS environments, and release builds remain excluded.

## Decision

Kanna keeps Cargo's mutable `build-dir` private to each checkout. The former
shared directory produced silent stale `.rmeta` reuse, so this cache must
never restore a shared Cargo path. Final target artifacts, sidecars, and Tauri
`externalBin` staging also remain private to the build that produced them.

The pinned Kanache revision is a development-only accelerator. Local macOS
commands enable it when `KANNA_RUST_CACHE` is unset, blank, `on`, or `kanache`.
Kanna-managed setup warms a fresh worktree after environment sync. The explicit
value `KANNA_RUST_CACHE=off` disables bootstrap, warming, and donor recording
as an immediate rollback.

The default-on decision follows a representative Kanna canary, not only the
fake-tool integration suite. The canary exposed retained Ghostty dynamic-library
symlinks that Kanache correctly refused; Kanna now removes those unused aliases
after the static Ghostty build while preserving the linked static library.

Release architecture is unchanged. Bazel remains the only release build path
and never installs or executes Kanache.

## Runtime eligibility

Kanache is eligible only when all three conditions hold:

1. `KANNA_RUST_CACHE` is unset, blank, `on`, or `kanache`;
2. the runtime platform is macOS (`darwin`);
3. `CI` is unset or blank.

Any nonblank `CI` value disables the cache, including values such as
`false`, because presence is the portable signal used by CI providers. A CI
invocation returns the observable category `disabled-in-ci`; a non-macOS
invocation returns `unsupported-platform`. Neither environment may bootstrap
Kanache, inspect donors, warm a destination, or record a donor. Existing
donor-marker revocation remains fail-closed around bounded Cargo workflows.

The eligibility decision lives in one policy function used by warm, build,
record, and status paths. Production defaults platform and environment inputs
from the current process. Unit tests inject both values instead of mutating
`process.platform` or depending on the host runner. The required matrix is:

| Platform | `CI` | Mode | Result |
| --- | --- | --- | --- |
| `darwin` | unset/blank | unset, blank, `on`, or `kanache` | eligible |
| `darwin` | nonblank | unset, blank, `on`, or `kanache` | `disabled-in-ci` |
| non-`darwin` | any | unset, blank, `on`, or `kanache` | `unsupported-platform` |
| any | any | `off` or unknown | disabled or `invalid-mode` |

Mode validation runs first, followed by platform and CI eligibility. This
keeps explicit rollback and invalid-value warnings stable while making the
macOS-only tests deterministic on Linux CI.

## Scope and invariants

The cache may:

- clone compatible Cargo intermediates from a clean, exact-`HEAD` worktree;
- publish them into an absent, destination-private `.build/cargo-build`;
- record donors only around bounded successful `kd` Rust workflows;
- log local timing and APFS allocation deltas.

It must not:

- share a mutable Cargo build directory;
- reuse across commits or repositories;
- replace or delete an existing destination build tree;
- expose a donor while a supported workflow mutates one of its declared
  layouts;
- source final binaries or Tauri staging inputs from another worktree;
- become a release, signing, packaging, or app runtime dependency.

## Pinned tool and command surface

The only accepted upstream is:

```text
repository: https://github.com/jemdiggity/kanache
revision:   6107c7b533a77a0c7c190b75c0284e7501c6edbf
```

`kd` installs it with locked Cargo resolution into:

```text
~/Library/Caches/kanna/tools/kanache/<revision>/bin/kanache
```

Installation uses a process-private temporary root, verifies `kanache
--version`, and atomically publishes the version directory. Kanna never uses a
floating ref or an arbitrary executable from `PATH`. A bootstrap failure is a
cache miss and cannot fail the underlying build.

The public development surface is:

```bash
./kd rust-cache warm
./kd rust-cache status
./kd build sidecars
./kd test rust
```

`.kanna/config.json` runs `./kd rust-cache warm` after `pnpm install` and
`./kd env sync`. `rust-cache warm` is idempotent. An existing
`.build/cargo-build` produces `destination-exists` and remains untouched.

## Donor discovery and publication

`kd` reads `git worktree list --porcelain` and filters candidates before
invoking Kanache:

1. the candidate is not the destination after filesystem canonicalization;
2. its canonical Git common directory equals the destination repository's;
3. its full commit hash exactly equals the destination `HEAD`;
4. it contains a regular manifest and success marker beneath a non-symlinked
   private build root;
5. its manifest declares profile `dev`, no extra inputs, and at least one
   supported host/Apple layout.

Filesystem canonicalization is necessary on macOS because the same temporary
path can appear as both `/var/...` and `/private/var/...`. The integration test
uses that real alias behavior and would reject every valid donor if identity
were compared lexically.

Candidates are ranked by reusable coverage: implicit host plus explicit host
target, implicit host only, explicit target only, then newest manifest.
Kanache remains the final authority for cleanliness, toolchain, lockfile,
Rust flags, layouts, build-script inputs, locking, and atomic publication. If
one candidate refuses, `kd` tries the next. It never combines multiple donors.

Kanna development layouts are:

- `host` for implicit Cargo host builds;
- the installed Rust host triple, normally `aarch64-apple-darwin`, for explicit
  sidecar builds.

## Donor-marker lifecycle

Before a supported bounded workflow starts Cargo, `kd` removes and directory-
syncs `.build/cargo-build/.kanache-success` independently of whether Kanache is
installed or enabled. Failure to revoke the marker prevents the Cargo mutation.
Eligible mode then runs `kanache manifest begin`. Only a clean, successful bounded
workflow may run `manifest record` and create a new marker.

The complete interval uses a repository-local cross-process lock. The lock
token can be inherited only by the intentional `test rust` → `build sidecars`
nesting. A malformed or ownerless lock fails closed; a verifiably dead process
owner may be recovered.

| Workflow | Cargo mutation and marker contract |
| --- | --- |
| `./kd build sidecars` | Revoke/begin, build and stage every explicit-target sidecar, then record only the explicit target after success. |
| `./kd dev up` | Runs the bounded sidecar command first. The later long-running Tauri host build is not recorded; the explicit-only marker cannot advertise host state. |
| `./kd test rust` | Holds the outer lifecycle lock, revokes before the suite, permits the nested sidecar lifecycle, runs host tests, then records host plus explicit layouts only if the full suite succeeds and no dev session is active. |
| `./kd build desktop` | Frontend/Turbo build only; it does not invoke Cargo and does not affect donor state. |
| `./kd clean --all` | Removes the private build tree, including any manifest and marker. |
| Bazel release commands | Never read, install, warm, or record Kanache state. |

Direct `cargo`, `pnpm exec tauri`, and other ad hoc Cargo invocations are not
donor-producing workflows. If a checkout was previously recorded while the
cache was enabled, remove its `.kanache-success` marker before any direct
Cargo mutation. Such commands may consume a private warmed tree, but they must
not leave it advertised as a supported donor. Checkouts with
`KANNA_RUST_CACHE=off` do not create these markers.

## Failure and observability

Disabled mode, unsupported platforms/filesystems, bootstrap errors, missing or
incompatible donors, an existing destination, Git/Rust discovery failures,
Kanache refusals, and recording failures all preserve the private cold-build
fallback. `kd` never deletes an existing destination to force a hit.

Warm and record attempts append JSON lines to:

```text
~/Library/Caches/kanna/kanache/events.jsonl
```

Events include repository identity, commit, destination, donor, layouts,
outcome/category, wall time, and allocation delta. `./kd rust-cache status`
shows the mode, pinned revision, installed binary, current manifest, and recent
repository events. Malformed historical events are ignored with a warning.

## Automated integration coverage

`tools/kd/tests/rust-cache.integration.test.ts` uses the real Node process
runner, real temporary Git repositories, and real linked worktrees. Only
Kanache is replaced with a deterministic executable. The suite verifies:

- exact-full-`HEAD` donor filtering;
- canonical same-repository filtering, including a registered path redirected
  to a foreign Git common directory;
- first-donor refusal and next-donor fallback;
- atomic destination publication by the tool substitute;
- no invocation or deletion when the destination exists;
- real-process `manifest begin` → build → `manifest record` ordering and final
  marker publication.

Normal CI also compiles but skips a real-pinned-tool smoke. A developer can run
it explicitly:

```bash
KANNA_REAL_KANACHE_ACCEPTANCE=1 \
  pnpm --dir tools/kd exec vitest run tests/rust-cache.integration.test.ts \
  --maxWorkers=1
```

That smoke bootstraps the exact pin, builds and records a tiny real Cargo donor,
warms a sibling worktree, rebuilds it, and checks that final executables have
different inodes. It is opt-in because it requires macOS/APFS, Git, the pinned
Rust/Cargo toolchain, network access on first bootstrap, substantial compile
time, and mutation of the user cache beneath `~/Library/Caches/kanna`. The fake
integration suite substitutes for orchestration correctness in ordinary CI;
the real smoke covers the external tool boundary when explicitly requested.

## Representative Kanna-scale canary

The default-on rollout used a manual canary with:

- macOS on APFS;
- Kanna's pinned Rust/Cargo toolchain;
- a clean 7–9 GiB donor and at least two fresh exact-`HEAD` Kanna worktrees;
- no active dev, Cargo, or competing disk-heavy processes;
- at least 20 GiB free disk for donor, cold control, and warmed destination;
- the exact pinned Kanache revision above.

Suggested flow:

```bash
export KANNA_RUST_CACHE=on
./kd test rust

# In a fresh exact-HEAD sibling whose .build/cargo-build is absent:
./kd rust-cache warm
./kd rust-cache status
./kd build sidecars
```

Capture a same-batch cold control and the warmed sibling. The rollout gates are:

1. **Warm time:** under 30 seconds for the representative donor.
2. **Physical growth:** under 1 GiB APFS free-space loss for the warmed private
   tree, measured independently from logical size.
3. **Invalidation:** source, `Cargo.lock`, features, `RUSTFLAGS`, target, and
   toolchain changes rebuild affected units and never execute stale behavior.
4. **Relocation:** moving between real Kanna worktree roots does not cause a
   registry rebuild solely because of absolute paths.
5. **Final privacy:** sidecars, desktop executables, and Tauri staging remain
   private paths with distinct inodes and never appear in a shared store.
6. **Concurrency/removal:** concurrent warm/record operations refuse or
   serialize safely, and donor removal does not break no-op or edited builds.

Record logical size/file count, physical allocation delta, warm wall time,
first sidecar and host build time, Cargo rebuilt/fresh units, and every
invalidation result.

The 2026-07-21 canary used a 9.6 GiB logical Kanna donor at exact commit
`b46222be`. A fresh relocated worktree warmed in 5.69 seconds; the measured
physical allocation delta was approximately 578 MB, below the 1 GiB gate. Its
sidecar build completed in 76.79 seconds, retained no symlinks in the Cargo
intermediate tree, and produced six staged binaries with inodes distinct from
their private build outputs. The source/build-script change rebuilt Ghostty.
Kanna's real and fake integration suites cover refusal, locking, publication,
relocation, donor removal, and final-binary privacy; the pinned Kanache manifest
validation remains authoritative for Cargo lockfile, feature, flag, target, and
toolchain invalidation.

These measurements establish the initial rollout, not permission to weaken the
isolation model. A future regression in any gate is a reason to set
`KANNA_RUST_CACHE=off` or revert the default, never to share Cargo's mutable
build directory or final artifacts.
