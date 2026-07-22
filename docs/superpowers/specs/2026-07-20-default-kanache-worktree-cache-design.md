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

- clone compatible Cargo intermediates from a clean worktree whose recorded
  Rust build-input hash matches the destination, including across commits;
- publish them into an absent, destination-private `.build/cargo-build`;
- record donors only around bounded successful `kd` Rust workflows;
- log local timing and APFS allocation deltas.

It must not:

- share a mutable Cargo build directory;
- reuse across repositories or across commits with different or indeterminate
  Rust build inputs;
- replace or delete an existing destination build tree;
- expose a donor while a supported workflow mutates one of its declared
  layouts;
- source final binaries or Tauri staging inputs from another worktree;
- become a release, signing, packaging, or app runtime dependency.

## Pinned tool and command surface

The only accepted upstream is:

```text
repository: https://github.com/jemdiggity/kanache
revision:   a8496326bc0a3551d3a2d78caa425ed474e816ae
```

`kd` installs it with locked Cargo resolution into:

```text
~/Library/Caches/kanna/tools/kanache/<revision>/bin/kanache
```

Installation uses a process-private temporary root, verifies `kanache
--version`, and atomically publishes the version directory. Kanna never uses a
floating ref or an arbitrary executable from `PATH`. A bootstrap failure is a
cache miss and cannot fail the underlying build.

Kanna passes the same generated-output exclusion to donor recording and every
exclusion-aware warm attempt:

```text
--exclude-rust-input-root apps/desktop/src-tauri/binaries
```

That repository-relative directory contains final sidecars staged for Tauri,
not reusable Rust inputs. Kanache validates the path, excludes it from both
identities, and persists the sorted/deduplicated requested set as
`rust_build_input_exclusions`. Warm requires the requested and recorded sets to
match exactly. This preserves final-artifact privacy without ignoring any Rust
source or build-script input outside the declared generated-output root.
The sole fallback is a true legacy exact-`HEAD` manifest with neither
`rust_build_inputs_blake3` nor `rust_build_input_exclusions`: kd omits the
exclusion option so pinned Kanache compares the legacy manifest against an
empty requested exclusion set. This fallback cannot cross commits.

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
3. its full commit hash exactly equals the destination `HEAD`, or its manifest
   contains a nonempty `rust_build_inputs_blake3` identity;
4. it contains a regular manifest and success marker beneath a non-symlinked
   private build root;
5. its manifest declares profile `dev`, no extra inputs, and at least one
   supported host/Apple layout.

The optional hash only admits a different-`HEAD` candidate to the Kanache
boundary. Kanache computes the destination identity and remains authoritative
for equality. A legacy manifest without `rust_build_inputs_blake3` is eligible
only at exact `HEAD`; this also preserves the conservative behavior of pinned
binaries and manifests that predate input-hash matching. A computed mismatch
is always a refusal, including when the commits happen to be equal.

Manifests predating `rust_build_input_exclusions` are also conservative: they
accept only an empty requested exclusion set. For a true legacy manifest that
also lacks `rust_build_inputs_blake3`, kd preserves the exact-`HEAD` fallback by
requesting no exclusions. A hash-bearing manifest without the exclusions field
does not qualify for that fallback and must be reseeded before kd can use it;
this prevents a cross-commit warm from silently changing the hashed-input
contract.

Filesystem canonicalization is necessary on macOS because the same temporary
path can appear as both `/var/...` and `/private/var/...`. The integration test
uses that real alias behavior and would reject every valid donor if identity
were compared lexically.

Candidates are ranked by reusable coverage: implicit host plus explicit host
target, implicit host only, explicit target only, then newest manifest, with
the canonical worktree path as the deterministic final tie-breaker.
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

Events include repository identity, commit, destination, donor, matching mode
(`head` or `input-hash`), layouts, outcome/category, wall time, and allocation
delta. `./kd rust-cache status` shows the enablement mode, pinned revision,
installed binary, current manifest, and recent repository events, including
the matching mode on each donor attempt. Historical events without the new
optional field remain readable; malformed JSON lines are ignored with a
warning.

## Automated integration coverage

`tools/kd/tests/rust-cache.integration.test.ts` uses the real Node process
runner, real temporary Git repositories, and real linked worktrees. Only
Kanache is replaced with a deterministic executable. The suite verifies:

- exact-full-`HEAD` legacy donor eligibility with no requested exclusions;
- different-`HEAD` donor eligibility only when the manifest contains a Rust
  build-input hash, with legacy different-`HEAD` manifests excluded before the
  binary is invoked;
- canonical same-repository filtering, including a registered path redirected
  to a foreign Git common directory;
- first-donor refusal and next-donor fallback;
- atomic destination publication by the tool substitute;
- no invocation or deletion when the destination exists;
- real-process `manifest begin` → build → `manifest record` ordering and final
  marker publication;
- identical `apps/desktop/src-tauri/binaries` exclusions on warm and record,
  with the recorded manifest persisting that exact set.

Normal CI also compiles but skips a real-pinned-tool smoke. A developer can run
it explicitly:

```bash
KANNA_REAL_KANACHE_ACCEPTANCE=1 \
  pnpm --dir tools/kd exec vitest run tests/rust-cache.integration.test.ts \
  --maxWorkers=1
```

That smoke first records a tiny real Cargo donor with pre-exclusion Kanache
revision `6107c7b533a77a0c7c190b75c0284e7501c6edbf`, verifies its manifest has
neither compatibility field, and warms an exact-`HEAD` sibling through the
current pinned process using `head` mode. It then records with the current pin,
adds a non-Rust-only commit in another sibling, warms it by input hash, rebuilds
it, and checks that final executables have different inodes. It is opt-in
because it requires macOS/APFS, Git, the pinned Rust/Cargo toolchain, network
access on first bootstrap, and substantial compile time. The fake
integration suite substitutes for orchestration correctness in ordinary CI;
the real smoke covers the external tool boundary when explicitly requested.

## Representative Kanna-scale canary

The default-on rollout used a manual canary with:

- macOS on APFS;
- Kanna's pinned Rust/Cargo toolchain;
- one clean 7–9 GiB recorded donor at a recent main commit and a fresh Kanna
  worktree with a TypeScript/mobile/docs-only commit;
- no active dev, Cargo, or competing disk-heavy processes;
- at least 20 GiB free disk for donor, cold control, and warmed destination;
- the exact pinned Kanache revision above.

Suggested flow:

```bash
export KANNA_RUST_CACHE=on
./kd test rust

# In a clean sibling with only non-Rust changes and no .build/cargo-build:
./kd rust-cache warm
./kd rust-cache status
./kd build sidecars
```

The status event for this canary must report `matchingMode: "input-hash"`.
One clean recorded donor can seed all branches whose complete Rust build-input
identity remains equal; a Rust package, lockfile, toolchain, Cargo config, or
other hashed-input change is refused and cold-builds. Legacy donors without an
input hash still require exact `HEAD`; true legacy manifests without an
exclusions field warm there with an empty requested set, but must be reseeded
to serve cross-commit worktrees.

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

The 2026-07-22 cross-commit canary against Kanache revision
`8334129cc427517c07a67a9916976f7371c7754d` recorded a clean 9.77 GiB logical
donor at Kanna commit `1e52b9cd` with Rust build-input identity `afa6ad7e` and
both host layouts. A destination at `ae95f0f5`, whose only committed difference
was a TypeScript file under `tools/kd`, was correctly offered that donor with
`matchingMode: "input-hash"`, but Kanache refused it in 684 ms (0.82 seconds
CLI wall time). The refused attempt consumed only a noisy 20 KiB APFS
free-space delta and published no destination tree.

Investigation found six ignored, generated sidecars beneath
`apps/desktop/src-tauri/binaries` in the donor. Kanache's complete package-root
hash includes those Tauri staging outputs because they live under the
`kanna-desktop` Cargo package; a fresh pre-warm destination necessarily lacks
them. Mirroring only those six files made a direct diagnostic warm succeed in
4.463 seconds for 49,729 files, proving the mismatch, but that is not an
acceptable workflow or rollout measurement: consuming donor final binaries
would violate final-artifact privacy. Cross-commit default warming therefore
remains blocked until Kanache can exclude caller-declared generated output
roots (or provide an equivalent repo-agnostic mechanism) from both donor and
destination Rust-input identity capture. The Kanna canary must then be rerun
without copying or prebuilding final artifacts before this evidence can count
as a rollout pass.

The follow-up 2026-07-22 canary used merged Kanache revision
`a8496326bc0a3551d3a2d78caa425ed474e816ae`. A clean detached main-tip donor at
Kanna commit `1e52b9cd` recorded the explicit `aarch64-apple-darwin` layout with
Rust identity `9250b1e5` and the sole exclusion
`apps/desktop/src-tauri/binaries`; its Cargo tree was 9.70 GiB logical. A clean
destination at `25abca75` differed only by one committed TypeScript file under
`tools/kd` and had no Cargo tree before warming. `kd rust-cache warm` selected
the donor with `matchingMode: "input-hash"` and published the 2.46 GiB logical
explicit-target layout in 5.72 seconds (5,554 ms in the event). The event's
APFS allocation delta was -5,349,376 bytes, meaning free space increased by a
noisy 5.10 MiB during the sample; independent `df` samples likewise increased
free space by 3.71 MiB. This is effectively zero physical growth and passes
both the 30-second warm and 1 GiB allocation gates without copying or
prebuilding destination final sidecars. The full `test rust` donor seed was
also attempted but correctly withheld publication after unrelated,
timing-sensitive daemon/desktop tests failed; the successful canary therefore
used the supported bounded `build sidecars` producer and advertises only its
explicit layout.

These measurements establish the initial rollout, not permission to weaken the
isolation model. A future regression in any gate is a reason to set
`KANNA_RUST_CACHE=off` or revert the default, never to share Cargo's mutable
build directory or final artifacts.
