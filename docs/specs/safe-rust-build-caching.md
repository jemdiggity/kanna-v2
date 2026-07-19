# Safe Rust Build Caching Across Kanna Worktrees

**Status:** Investigation and design recommendation, 2026-07-18<br>
**Toolchain tested:** `rustc 1.93.1`, `cargo 1.93.1`,
`aarch64-apple-darwin`<br>
**Decision:** Keep Cargo's mutable build directory isolated per worktree. Do
not restore a raw shared `build.build-dir`. Preserve Kanna's intentional split:
Cargo/Tauri/Vite for interactive development and Bazel for deterministic
release builds. Do **not** integrate kache 0.10.0 yet. A full dependency-only
canary was correct and achieved a 91.7% cross-root dependency hit rate, but it
reduced a fresh sibling's physical disk growth by 47.6% (below the 50% gate)
and wall time by only 10.8% (below the 30% gate). Keep the proof of concept for
future kache/Cargo improvements; it is not enough to justify a 64 KLoC
compiler-adjacent dependency today.

## Executive summary

Kanna's current layout is the correct correctness boundary:

```toml
[build]
target-dir = ".build"
build-dir = ".build/cargo-build"
```

The target directory keeps final artifacts private. The build directory keeps
Cargo fingerprints, dependency metadata, incremental state, and build-script
output private. Both properties matter.

The former global build directory was not merely vulnerable to a theoretical
race. On the pinned Cargo 1.93.1 toolchain, a sequential two-worktree probe
silently returned an old library while reporting the changed crate as `Fresh`.
Private final target directories did not protect the result because Cargo
copied the stale intermediate artifact into the second private target.

The disk cost is real. At the start of this investigation, eight registered
worktrees with Rust outputs occupied 71.16 GiB. In a representative 9.51 GiB
worktree, 9.19 GiB (96.6%) was `.build/cargo-build`; checkout-private top-level
outputs occupied 331 MiB. Cargo has no size budget or eviction policy for this
build directory.

A content-addressed compiler cache is already present for Kanna's release
graph. `.bazelrc` points all worktrees at the same Bazel disk cache, while
Bazel's output base and materialized final outputs remain private to each
workspace. This validates the intended architecture for release, but it does
not address the reported disk bucket: the duplicated artifacts come from the
deliberately separate Cargo/Tauri development path.

Released `sccache` is not ready for Kanna's remaining Cargo worktree topology.
A disposable sccache 0.14.0 probe achieved 13/13 hits after deleting and
rebuilding the *same*
source root (6.17 s cold, 1.91 s cached). Two byte-identical copies in different
roots achieved 0/26 hits even with `SCCACHE_BASEDIRS`. Upstream issue
[mozilla/sccache#2652](https://github.com/mozilla/sccache/issues/2652) confirms
that `SCCACHE_BASEDIRS` was not wired into Rust cache keys; the fix in
[mozilla/sccache#2678](https://github.com/mozilla/sccache/pull/2678) was still
open during this investigation.

`kache` 0.10.0 is a closer fit today. It normalizes checkout paths in Rust
cache keys, content-hashes source inputs, and restores cached artifacts into
each worktree's private Cargo tree using APFS copy-on-write clones. In a
two-root `kanna-tool-catalog` probe, the second implicit-host build fell from
5.06 s to 2.47 s and restored 8 entries from a 50.8 MiB shared cache. An
explicit `--target aarch64-apple-darwin` probe fell from 5.28 s to 3.10 s and
restored 12 entries. A changed-source negative control missed the cache and
passed with the changed behavior. User-facing executables are not cached by
default, which matches Kanna's private-sidecar requirement.

The important caveat is that `kache` strips Rust incremental-compilation flags
from every invocation it handles, including excluded and disabled invocations.
The canary should therefore not point Cargo directly at `kache`. A small
Kanna-owned `RUSTC_WRAPPER` dispatcher should send registry/git dependencies to
the pinned cache binary and execute rustc directly for Kanna workspace sources
and user-facing executables. That preserves incremental recompilation where
developers edit code while sharing the much larger, mostly identical
third-party dependency artifacts.

The full canary used Kanna's exact `.build` / `.build/cargo-build` layout and
the canonical `./kd build sidecars` followed by desktop Cargo build. The warm
sibling restored 697 of 760 cacheable invocations directly (91.7%), with 12
misses and 51 duplicate stores. It took 132.95 s versus 149.00 s for a
same-batch direct-Cargo checkout, a 10.8% improvement. APFS free-space deltas
were 3,855,836 KiB for the cached sibling and 7,354,672 KiB for direct Cargo,
a 47.6% reduction. Kache reported 1.8 GB restored with 100% zero-copy. These are
material savings, but they miss both adoption gates.

Correctness boundaries held. All 33 Kanna workspace compiler invocations were
classified direct-to-rustc, no workspace source went through kache, the six
sidecars and desktop executable had private paths and distinct inodes in each
checkout, and no named final appeared in the shared store. A simultaneous
one-line Kanna edit took 6.82 s through the dispatcher versus 6.68 s through
direct rustc (2.1% regression), and workspace incremental state remained
present. A changed-`RUSTFLAGS` control produced zero hits. Absolute timings
were noisy because other Kanna worktrees were compiling concurrently, so only
same-batch and simultaneous comparisons are used for the decision.

The recommended sequence is therefore:

1. Preserve the current per-worktree build directory and add a regression test
   that two worktree roots never resolve to the same raw Cargo build directory.
2. Retain the tested dependency-only wrapper as an experimental proof of
   concept; do not wire it into `kd` or checked-in Cargo configuration.
3. Re-test a later kache/Cargo release only if it can plausibly clear both the
   50% physical-disk and 30% sibling-build gates, or if Kanna deliberately
   lowers those product requirements.
4. Benchmark one consistent Cargo host-target mode. Implicit-host and explicit
   `--target aarch64-apple-darwin` builds currently duplicate all 206 logical
   crates present in the explicit-target dependency set.
5. Treat existing worktree teardown as a backstop, not the sharing design. It
   bounds closed-task storage but cannot reduce duplication among active stage
   workspaces.
6. Keep release builds independent of either compiler cache. Release commands
   must work with no cache binary, no network bootstrap, and hostile inherited
   wrapper variables.

## Current Kanna behavior

Commit `f35446cc` set a single
`~/Library/Caches/kanna/rust-build` as `build.build-dir` while leaving final
outputs in checkout-local `.build`. Commit `38026549` restored
`.build/cargo-build` after cross-worktree `.rmeta` reuse broke Cargo
verification. The current `kd` context also replaces the legacy global value
when it inherits that exact path, while preserving an explicit custom override.

The relevant source-of-truth paths are:

- `.cargo/config.toml`
- `scripts/setup-worktree.sh`
- `tools/kd/src/runtime/env-sync.ts`
- `tools/kd/src/context.ts`
- `tools/kd/src/runtime/sidecars.ts`

Sidecars are built with an explicit host triple and final files are staged from
checkout-local `.build/<target>/<profile>` into
`apps/desktop/src-tauri/binaries`. This boundary must not change. A compiler
cache may accelerate rustc; it must never become a source path for sidecar
staging, daemon launch, Tauri `externalBin`, signing, or packaging.

The repository teardown already includes:

```json
"teardown": ["./kd dev down --kill-daemon", "./kd clean --all"]
```

That removes `.build` when a workspace is successfully departed. The remaining
gaps are failed/bypassed teardown, observable accounting, and the aggregate
cost of multiple current workspaces that have not departed yet.

### Existing Bazel release-only boundary

Kanna already uses Bazel 9, `rules_rust` 0.69.0, and a pinned Rust 1.93.1
toolchain for release builds. The release graph contains the desktop Rust
binary, Tauri context generation and bundling, all final sidecars, signing,
notarization, updater bundles, and arm64/x86_64 targets.

The checked-in `.bazelrc` configures:

```text
build --disk_cache=~/Library/Caches/kanna-bazel/disk-cache
build --repository_cache=~/Library/Caches/kanna-bazel/repository-cache
```

The disk cache is an action cache plus content-addressed output store, designed
for reuse across branches and multiple checkouts. Bazel still creates a
workspace-specific output base, and `kd clean` removes that private output base
without selecting the shared disk cache for deletion. This is the intended
shared-intermediates/private-materialization architecture, unlike a shared
Cargo build directory.

At inspection time the configured shared disk and repository caches contained
only their sentinels (4 KiB each), and this worktree had no Bazel output base,
so the current machine did not provide a meaningful warm-cache timing or size
sample. This report does not use Bazel cache size or timing as evidence for the
Cargo development recommendation.

This does not solve the interactive development footprint. The separation is
an explicit product/build decision, not missing wiring. The
[repository README](../../README.md) states that `./kd dev up` and Bazel are
intentionally separate entry points. The original
[`rules_tauri` release design](../superpowers/specs/2026-04-08-rules-tauri-release-design.md)
says the Bazel boundary is release assembly, not replacing Vite or Tauri
development, and explicitly excludes `tauri dev`.
Development depends on Vite's dev URL/HMR, worktree-specific ports and local
Tauri config, and WebDriver-backed E2E behavior. Bazel consumes a deterministic
frontend distribution and release-shaped Tauri context instead.

Bazel outputs also cannot safely seed Cargo's fingerprint directory. Maintain
and bound the Bazel release cache as its own concern, but do not expand Bazel
into development merely to solve Cargo cache storage.

## Cargo 1.93.1 behavior

### What `build-dir` does

Cargo distinguishes:

- `target-dir`: user-facing final artifacts such as binaries.
- `build-dir`: mutable internal artifacts such as `.fingerprint`, `deps`,
  `incremental`, and build-script output.

This split stabilized in Cargo 1.91. Cargo explicitly describes the build-dir
layout as internal and points users to sccache for a shared cache. See the
[Cargo build cache reference](https://doc.rust-lang.org/cargo/reference/build-cache.html)
and the [Cargo configuration reference](https://doc.rust-lang.org/cargo/reference/config.html#buildbuild-dir).

The pinned toolchain supports these build-dir template variables:

- `{workspace-root}`
- `{cargo-cache-home}`
- `{workspace-path-hash}`

Local verification produced:

```text
CARGO_BUILD_BUILD_DIR={cargo-cache-home}/kanna-probe/{workspace-path-hash}
build_directory=/Users/jeremyhale/.cargo/kanna-probe/71/9eee22c7fa3a40
```

`{workspace-path-hash}` hashes the manifest path, so different Kanna worktree
paths receive different directories. The Cargo team uses the same pattern in
its proposed global layout:

```text
{cargo-cache-home}/build/{workspace-path-hash}
```

See [cargo#16147](https://github.com/rust-lang/cargo/issues/16147).

This template is a safe way to *relocate* isolated intermediates to a central
cache root. It is not content deduplication and does not reduce total bytes by
itself. Kanna currently gains simpler ownership and cleanup by leaving the
isolated directory inside each worktree.

`cargo config get` is still nightly-only on Cargo 1.93.1. Tests should inspect
the stable `build_directory` field from `cargo metadata --format-version 1`
instead.

### Silent stale-artifact reproduction

The reproduction used two immutable source snapshots of the same package:

- old: commit `7de8adb5`, `crates/kanna-tool-catalog`
- new: current `HEAD`, which contains the newer `"unknown argument:"` string

Both snapshots had private `CARGO_TARGET_DIR` values and one shared raw
`CARGO_BUILD_BUILD_DIR`:

```text
old source -> old-target    \
                              shared-build/debug/{deps,.fingerprint,incremental}
new source -> new-target    /
```

Observed on Cargo 1.93.1:

```text
Fresh kanna-tool-catalog v0.1.0 (.../new/crates/kanna-tool-catalog)
Finished `dev` profile ... in 0.18s
new-shared-marker=absent
new-control-marker=present
sha-shared=f7a24a57ca2b9fdfa20a1789f067ef51075c9d6ce974a3e9d0861b9c3d395cdf
sha-control=5ca31fd52cb6937820f3a07e5dc943cd561c7eaa81d643b2bd5477c425543c02
```

The new private target received an artifact compiled from the old source.
Cargo dep-info files contain absolute source paths by default, and the shared
fingerprint/dependency state still described the first root. This is consistent
with Cargo checking the first root's unchanged inputs and declaring the unit
fresh. The result is more severe than a missing `.rmeta`: a build can succeed
with wrong code.

This occurred sequentially, so process locking cannot make a single raw shared
directory correct. Concurrency adds serialization and further mutation risk,
but it is not required to trigger the bug.

### Implicit host versus explicit target

Cargo intentionally uses different layouts and compilation modes:

- no `--target`: `<build-dir>/debug/...`
- `--target aarch64-apple-darwin`:
  `<build-dir>/aarch64-apple-darwin/debug/...`, while build scripts and
  procedural macros still build for the host

Kanna currently mixes both modes: desktop/Tauri development is an implicit
host build, while sidecars use an explicit `--target` equal to the host triple.
In the representative cache:

| Set | Logical `.rmeta` crate names |
| --- | ---: |
| Implicit-host `debug/deps` | 403 |
| Explicit-target `aarch64-apple-darwin/debug/deps` | 206 |
| Present in both | 206 |

Every logical crate in the explicit-target set also existed in the implicit
host set, although Cargo correctly generated different artifacts/hashes for
the two modes. Cargo 1.93.1 supports `build.target = "host-tuple"`, so making
all host builds explicit is a plausible independent optimization. It needs a
full Tauri, sidecar, test, and release benchmark before adoption; merely
moving paths does not prove that host build-script and target dependency
duplication will fall by the apparent 2.24 GiB explicit-target subtree size.

## Disk measurements

Measurements were read-only snapshots of registered Kanna worktrees. The total
changed while other tasks progressed, so the values are evidence of scale, not
a durable inventory record.

At the initial snapshot:

```text
registered worktrees with .build: 8
aggregate .build size:            71.16 GiB
smallest:                           1.71 GiB
largest:                           16.68 GiB
```

A representative 9.51 GiB worktree broke down as follows:

| Path | Apparent size | Notes |
| --- | ---: | --- |
| `.build/cargo-build` | 9.19 GiB | 96.6% of the worktree build tree |
| `.build/debug` | 183 MiB | private implicit-host final outputs |
| `.build/aarch64-apple-darwin` | 147 MiB | private explicit-target final outputs |
| `cargo-build/debug/deps` | 5.19 GiB | host-mode dependencies and crate artifacts |
| `cargo-build/debug/incremental` | 1.73 GiB | incremental state |
| `cargo-build/debug/build` | 711 MiB | build scripts and output |
| `cargo-build/aarch64-apple-darwin/debug/deps` | 1.53 GiB | explicit-target dependencies |
| `cargo-build/aarch64-apple-darwin/debug/incremental` | 682 MiB | explicit-target incremental state |
| `cargo-build/aarch64-apple-darwin/debug/build` | 297 MiB | explicit-target build output |

Subdirectory values are apparent sizes and are not strictly additive because
Cargo can hard-link copied artifacts. The ownership conclusion is unaffected:
dependency, incremental, and build-script state dominates; final outputs are a
small minority.

Disabling incremental compilation would remove roughly 2.39 GiB of apparent
state in this example and is required for sccache to cache workspace/path
crates. It is not a free win: it sacrifices fast local edit/rebuild cycles and
does not remove dependency `.rlib`/`.rmeta` trees. It should only be enabled in
a measured cached-build profile, not unconditionally in checked-in Cargo
config.

## sccache evaluation

### What it can safely share

sccache wraps rustc and stores outputs by a key derived from the compiler
invocation and inputs. Features, target, compiler flags, and rustflags appear
in the rustc invocation and should therefore form distinct keys. This is a
content-addressed/result-cache boundary, unlike Cargo's mutable freshness
directory.

It also has important Rust limitations:

- Incrementally compiled crates are not cacheable.
- Crates that invoke the linker (`bin`, `dylib`, `cdylib`, and `proc-macro`)
  are not cacheable.
- Build-script execution and its arbitrary filesystem/environment behavior are
  not replaced by a Cargo-aware cache.
- Cache correctness still depends on sccache correctly recognizing every
  relevant rustc argument and environment input.

See the [sccache README](https://github.com/mozilla/sccache) and
[Rust caveats](https://github.com/mozilla/sccache/blob/main/docs/Rust.md).

### Measured probe

The local Homebrew sccache 0.14.0 binary was used only as an experiment. It is
not an acceptable Kanna dependency. The probe packaged
`kanna-tool-catalog`, used disposable source/build/cache directories, disabled
incremental compilation, and ran an isolated sccache server.

| Scenario | Wall time | Result |
| --- | ---: | --- |
| Cold sccache build, one root | 6.17 s | 13 Rust misses, 9 MiB cache |
| Same root after deleting `.build` | 1.91 s | 13 Rust hits |
| Cold build without sccache | 4.28 s | baseline |
| Byte-identical second root with `SCCACHE_BASEDIRS` | 6.83 s | 0 cross-root hits |

The first cross-root attempt, with build directories outside the normalized
source roots, also produced zero hits. Repeating it with identical relative
`.build/cargo-build` paths under each normalized source root still produced
zero hits. A same-root-after-clean control produced 13/13 hits, proving the
cache itself was functioning.

The upstream status explains the result:

- [sccache#2652](https://github.com/mozilla/sccache/issues/2652):
  `SCCACHE_BASEDIRS` only covered the C compiler; Rust hash keys retained
  absolute paths.
- [sccache#2678](https://github.com/mozilla/sccache/pull/2678): open change to
  normalize Rust cwd, Cargo path environment variables, dep-info values, and
  path-bearing arguments.
- [sccache#2595](https://github.com/mozilla/sccache/issues/2595): open issue for
  dynamically created git worktree roots; a static list becomes stale as
  agents create worktrees.

The current released sccache 0.16.0 provides published SHA-256 files and
prebuilt Apple Silicon/Intel macOS archives, but it does not include the open
Rust-key fix. It should not be adopted for Kanna cross-worktree reuse yet.

### Vendoring and release portability

When a suitable upstream release exists, Kanna should not discover sccache
from `PATH` and should not require Homebrew. Use a small committed tool manifest
containing:

- exact sccache version
- official GitHub release URL for each supported macOS architecture
- SHA-256 for each archive
- expected executable name and version output

Bootstrap the binary into a Kanna-owned tooling cache, verify the SHA before
extraction, and inspect the resulting binary with `otool -L`. The experimental
Homebrew 0.14.0 binary linked only Apple system frameworks/libraries, but the
official pinned binary must be checked independently.

sccache should remain optional for development:

- `kd` sets `RUSTC_WRAPPER` to the exact pinned path only when the verified
  binary exists and the cache feature is enabled.
- Missing/corrupt sccache falls back to direct rustc with a visible warning.
- Release, signing, and packaging plans explicitly remove `RUSTC_WRAPPER`,
  `RUSTC_WORKSPACE_WRAPPER`, and sccache configuration variables.
- No final artifact or staging path points into `SCCACHE_DIR`.

This keeps release output portable and makes cache rollback an environment
change rather than a build-layout migration.

## kache evaluation

### Why it matches worktrees

[`kache`](https://github.com/kunobi-ninja/kache) is a Rust-specific compiler
cache. Unlike Cargo's build directory, its shared store is content-addressed:
the key includes the rustc version, crate inputs and dependencies, target,
features, rustflags, emit modes, and normalized path-bearing arguments. Source
files discovered through dep-info are hashed by content. Absolute checkout
roots are normalized so the same commit in two worktree directories can
produce the same key.

Each Cargo invocation still owns a private target/build directory. A cache hit
is materialized there with an APFS reflink when available, giving the worktree
its own inode and copy-on-write semantics while the unchanged data blocks are
physically shared. Kache falls back to immutable hard links or copies on filesystems
without reflinks. This is fundamentally different from pointing two Cargo
processes at one mutable fingerprint directory.

By default, user-facing `bin` and test executables are passed through instead
of cached. Dynamic libraries and proc macros are cacheable. Kanna should leave
`KACHE_CACHE_EXECUTABLES` false so sidecars, Tauri `externalBin` inputs, and
packaged finals are always produced in and staged from the current checkout.

### Measured cross-root probes

Version 0.10.0 was downloaded from its official macOS arm64 release asset into
a disposable directory. The 6.64 MiB archive had SHA-256
`95dc669c5c8b8d5b21112b230849fca5945cc59fd525f31eb79abd9a519b1d87`.
The extracted 14,961,488-byte binary was Developer ID signed and `otool -L`
reported only Apple system frameworks/libraries. These checks characterize the
probe; they are not a substitute for a committed Kanna tool manifest.

Two byte-identical HEAD archives of Kanna were built with separate
`CARGO_TARGET_DIR` and `CARGO_BUILD_BUILD_DIR` values and one shared local
cache:

| Scenario | Root A, cold | Root B, identical sibling | Cross-root result |
| --- | ---: | ---: | --- |
| `kanna-tool-catalog`, implicit host | 5.06 s | 2.47 s | 8 local hits; 51% wall reduction |
| `kanna-tool-catalog`, explicit `aarch64-apple-darwin` | 5.28 s | 3.10 s | 12 local hits; 41% wall reduction |

The implicit-host run stored 50.8 MiB and restored 14.6 MiB into the second
private tree; its report classified those restores as 100% zero-copy. The two
trees still show their full apparent size under `du`, because APFS reflinks
have private directory entries. Physical savings must be measured from APFS
allocated blocks or volume free-space deltas, not by summing apparent sizes.

A smaller two-root crate produced one cold miss followed by one local hit. A
source edit in root B then produced a miss and the changed test passed. This
checks both cross-directory reuse and basic source invalidation. It does not
prove correctness for Kanna's full Tauri graph, build scripts, every rustflag,
or concurrent builds.

### Full Kanna dependency-only canary

The full canary used three byte-identical local Git checkouts of HEAD:

- root A populated a local-only 10 GiB kache store
- root B used the warm store with the dependency-only dispatcher
- root C was a direct-Cargo control

All roots used Kanna's real checkout-local paths: `.build` for final targets
and `.build/cargo-build` for Cargo intermediates. Each ran the canonical
explicit-target `./kd build sidecars` flow followed by the implicit-host
desktop Cargo build. `KACHE_CACHE_EXECUTABLES=0` and
`KACHE_VERIFY_RESTORES=always` were set. The remote, planner, and S3 paths were
disabled.

An initial harness placed build directories beside rather than inside each
checkout. Kache's event roots showed that this prevented consistent path
normalization and caused about 122 safe misses plus roughly 0.9 GiB of new
cache data per root. Those performance/storage results were discarded. This
is evidence that a future integration must preserve the exact relative Cargo
layout; arbitrary private directories are correct but can destroy cache hits.

The corrected same-batch results were:

| Measurement | Warm kache root B | Direct Cargo root C | Difference |
| --- | ---: | ---: | ---: |
| Sidecars wall time | 64.38 s | 67.59 s | 4.7% faster |
| Desktop wall time | 68.57 s | 81.41 s | 15.8% faster |
| Combined wall time | 132.95 s | 149.00 s | **10.8% faster** |
| APFS volume growth | 3,855,836 KiB | 7,354,672 KiB | **47.6% less** |
| Checkout `.build` allocation | 7,044,604 KiB | 7,728,580 KiB | 8.9% less apparent allocation |

The APFS values are before/after free-space deltas over each complete build.
Other Kanna tasks were active, so they are not laboratory-grade unique-block
accounting; the paired delta and kache's own restore report point in the same
direction. Kache reported:

- 697 direct local hits across the second root
- 12 misses and 51 duplicate stores across 760 cacheable invocations
- 91.7% direct cross-root hit rate for root B
- 1.8 GB restored, 100% by zero-copy APFS restore
- a 2.6 GiB physical store after roots A and B
- about 274 ms average hit overhead under the contended run

The classification log contained 864 dependency-to-kache and 59 direct
wrapper decisions per root. All 33 source-bearing Kanna workspace decisions
were direct; zero Kanna source paths were classified to kache. All staged
sidecars and the desktop executable had checkout-private paths and distinct
inodes. A search of the content store found no named desktop or sidecar final.

Four edit/rebuild pairs were noisy when run sequentially because the first
build in a pair often paid transient filesystem/host contention. In the fair
simultaneous pair, adding the same comment to `kanna-runtime-defaults` rebuilt
the workspace crate and desktop in 6.82 s with the dispatcher and 6.68 s with
direct Cargo: a 2.1% regression. The wrapper log classified the crate direct,
and its incremental directory remained present. A separate changed-
`RUSTFLAGS` two-root control produced 22 misses and zero hits, confirming key
separation for that input.

Outcome: the mechanism is correct and useful, but kache 0.10.0 fails the
adoption thresholds of 50% physical reduction and 30% sibling build-time
improvement. It should remain an experimental proof of concept, not a Kanna
development dependency.

Because those quantitative gates failed, the canary stopped before full Rust
test-suite, Tauri dev-startup, frontend-only edit, corrupted-store retry,
x86_64, release-dry-run, and simultaneous clean-worktree tests. Those checks
remain mandatory if a later version is reconsidered; none can be inferred from
this result.

### Incremental-compilation tradeoff and dependency-only wrapper

Kache 0.10.0 strips `-C incremental=...` from every rustc invocation it
executes. Its `cache.exclude` option bypasses lookup/store, but the passthrough
compile still has incremental flags removed. `KACHE_DISABLED=1` behaves the
same way. Pointing all of Kanna at kache would therefore trade fast local
workspace edits for cross-worktree reuse before that trade has been measured.

The canary used a small Kanna-owned dispatcher as
`RUSTC_WRAPPER`:

```text
rustc invocation
  source belongs to this Kanna checkout? -> execute real rustc directly
  otherwise                              -> execute pinned kache with real rustc
```

The classifier should use a canonical source/workspace path, not crate names:
a registry crate can share a name with a workspace crate, and Kanna crates may
be built as dependencies. It must fail closed to direct rustc if classification
is uncertain. This gives Cargo incremental compilation to locally edited
workspace crates, while registry/git dependencies—the dominant repeated
bucket—use a cross-root content cache. Build scripts still run privately;
their compiled helper crates may hit only when the complete modeled input key
matches.

The proof-of-concept dispatcher fails closed to direct rustc when the binary is
absent or source classification is uncertain. Because it `exec`s kache, an
unexpected kache failure currently fails that Cargo invocation; a production
integration would need a visible command-level retry through direct Cargo in
`kd`, rather than risking duplicate rustc execution inside the compiler
wrapper. Release commands would explicitly clear both Cargo wrapper variables
and all `KACHE_*` variables before invoking Bazel or any Cargo helper.

### Maturity and supply-chain cost

Kache is young and should be treated as a canary, not trusted merely because
the small probes passed. Tag 0.10.0 contains about 64,481 raw Rust lines in its
production `src` tree (78,651 including the repository's Rust tests and other
Rust sources), larger than the roughly 54,000 raw Rust lines measured for
sccache. It is Apache-2.0 licensed and offers signed release binaries, but Kanna
would still be accepting a substantial compiler-adjacent dependency.

Pin the exact version and per-architecture SHA-256, keep the cache local-only,
disable its daemon/remote planner/S3 paths initially, and enable restore
verification during the canary. A Kanna build must never download it on the
release critical path or discover an arbitrary binary from `PATH`.

## Approach comparison

| Approach | Correct across worktrees | Saves active-worktree disk | Parallel | Operational result |
| --- | --- | --- | --- | --- |
| One raw global Cargo `build-dir` | **No**; silent stale output reproduced | High | Locks/contended | Reject permanently |
| Global root plus `{workspace-path-hash}` | Yes | No deduplication | Yes | Safe relocation only |
| Current local `.build/cargo-build` | Yes | No | Yes | Keep as baseline |
| Current released sccache + isolated build dirs | Yes, but no cross-root hits measured | Little; adds cache | Yes | Do not roll out for this goal |
| Kache for every Rust unit | Cross-root hit and invalidation measured on small crates | Expected high; reflinked private trees | Yes | Do not adopt unscoped; disables workspace incremental |
| Kache 0.10 dependencies via Kanna dispatcher | Correct; 91.7% direct hits in full graph | 47.6% paired volume reduction | Yes | Canary passed safety but missed disk/time gates; do not integrate |
| Future fixed sccache + isolated build dirs + no incremental | Expected, subject to tests | Enables aggressive local eviction | Yes | Retain as a future alternative |
| Standardize all host builds on explicit `host-tuple` | Expected | Potentially reduces dual-mode duplication | Yes | Benchmark independently |
| Existing Bazel release graph + shared disk cache | Yes; action-keyed CAS | Does not reduce Cargo dev trees | Yes | Keep release-only; separate concern |
| Extend Bazel into interactive development | Expected cache correctness | Potentially high | Yes | Reject for this task; violates intentional dev/release boundary |

## Cache scope, limits, and observability

### Initial scope

Use a per-repository cache for the first kache canary:

```text
~/Library/Caches/kanna/rust-kache/<repo-identity>/
```

A global cache is theoretically safe when keys are correct, but it broadens
the blast radius of cache bugs, obscures attribution, and lets one imported
repository evict another. Cross-repository reuse is likely lower than
cross-worktree reuse because lockfiles, toolchains, targets, and flags differ.
Per-repository scope is easier to inspect, cap, clear, and roll back. A later
measurement can justify a global tier.

### Proposed defaults

- kache: 10 GiB per repository through `KACHE_MAX_SIZE`. Its upstream default
  is 50 GiB, which is too large when Kanna imports several repositories.
- Cargo intermediates: report an aggregate per-repository budget first; do not
  silently delete a current workspace's cache.
- Keep the existing stage/close teardown. It limits dormant storage but is not
  counted as cache sharing and cannot meet the active-worktree goal.
- Garbage-collect the shared content store by least-recent use within its hard
  cap. Never delete a current worktree's private build tree as cache eviction.

Kache exposes `stats`, `report`, and `gc`, including hit/miss/passthrough
counts, restored bytes, restore method, time saved, current/max bytes, and
evictions. Kanna should surface rather than hide these values.

Add `kd rust-cache status [--json]` with:

- repo identity and toolchain
- each registered worktree, task/stage/current/departed state
- target bytes versus Cargo build bytes
- newest artifact timestamp
- live daemon/session eligibility
- kache version, verified path, configured cap, used bytes, hits, misses,
  passthroughs, restore method, evictions, and errors
- total reclaimable bytes

Add `kd rust-cache prune --dry-run` before any automatic policy. Every proposed
removal should include the path, bytes, reason, and why it is safe. Never infer
deletion targets from an unresolved environment variable or glob.

## Recommended implementation plan

### Phase 1: Lock in the safety boundary and add accounting

**Goal:** prevent regression and quantify active-worktree duplication without
changing builds.

Files:

- Modify `.cargo/config.toml` only if comments are useful; keep both paths
  checkout-local.
- Modify `tools/kd/tests/context.test.ts` and
  `tools/kd/tests/env-sync.test.ts`.
- Create `tools/kd/src/runtime/rust-cache.ts`.
- Create `tools/kd/tests/rust-cache.test.ts`.
- Modify `tools/kd/src/tasks/registry.ts` and `tools/kd/src/cli.ts` for the
  read-only `kd rust-cache status` command.
- Deprecate the misleading legacy-global-only behavior behind
  `kd clean --shared-rust-build` in `tools/kd/src/runtime/clean.ts`; retain a
  compatibility cleanup path for the old directory.

Tests:

1. Resolve two Kanna-shaped worktree roots and assert distinct
   `CARGO_BUILD_BUILD_DIR` values.
2. Run `cargo metadata --no-deps --format-version 1` and assert
   `build_directory` is under the current worktree.
3. Add a fixture equivalent to the stale probe: raw shared build-dir is the
   negative control; Kanna's resolved directories must produce the current
   marker in both private targets.
4. Inventory fixtures distinguish final target bytes from build-dir bytes and
   never follow symlinks outside the worktree.
5. `status --json` is deterministic and does no writes.

Verification:

```bash
pnpm --dir tools/kd test
pnpm test
./kd test rust
```

Rollback: command-only changes can be removed without touching build output.

### Phase 2: Run a dependency-only kache canary

**Goal:** establish the disk and interactive-build tradeoff on the real Kanna
Tauri graph without changing checked-in build behavior.

**Result:** completed as the proof of concept under
`scripts/experiments/`. Correctness and edit-loop gates passed. Physical disk
reduction was 47.6% versus the 50% gate, and combined sibling wall-time
improvement was 10.8% versus the 30% gate. Phase 4 is therefore not entered.

Build a disposable minimal dispatcher that resolves the primary Rust source
path for each wrapper invocation. Sources under the tested checkout execute
the real compiler directly; sources outside it execute pinned kache 0.10.0.
Unknown or malformed invocations execute the real compiler. Use:

- private target and build directories for every root
- one disposable per-repository kache store with a 10 GiB cap
- `KACHE_LOCAL_ONLY=1`
- `KACHE_CACHE_EXECUTABLES=0`
- `KACHE_VERIFY_RESTORES=always`
- no daemon, remote planner, S3, or inherited user config

Benchmark at least three byte-identical worktrees in both the current implicit
host desktop mode and explicit `--target aarch64-apple-darwin` sidecar mode.
For each, record cold first build, cold sibling checkout, warm no-op, a one-line
Kanna crate edit/revert, frontend-only edit, and concurrent sibling builds.

Capture:

- wall/user/system time and compiled/fresh crate counts
- cache hit/miss/passthrough counts and restore method
- APFS volume free-space deltas before/after each private tree, not only `du`
- private `deps`, `incremental`, `build`, and final-output apparent bytes
- staged sidecar SHA-256, architecture, code-signing state, and source path
- wrapper logs proving workspace crates went directly to rustc

Acceptance gates:

- changed sources, features, rustflags, targets, and toolchains never hit an
  incompatible entry
- concurrent worktrees never share a mutable Cargo directory or contested
  final file
- at least 50% physical-byte reduction across three active builds
- at least 30% median sibling-build wall-time improvement
- no more than 10% regression for a one-line workspace edit/rebuild
- Tauri dev startup, full Rust tests, sidecar staging, and final privacy pass

If workspace edit performance misses the gate, stop. Do not compensate by
sharing Cargo state or by deleting active caches.

### Phase 3: Benchmark one Cargo host compilation mode

**Goal:** determine whether `build.target = "host-tuple"` reduces real Kanna
bytes/time by eliminating implicit/explicit-host duplication.

Run in disposable worktrees with clean isolated build directories:

1. Current mode: desktop implicit host, then `./kd build sidecars` explicit
   host.
2. Reversed order.
3. All-host-explicit mode, including Tauri dev/test and sidecars.
4. Repeat warm no-op and one-line workspace-crate edit builds.

Capture wall/user/system time, peak RSS, build-dir bytes by
`deps`/`incremental`/`build`, compiled/fresh crate counts, and staged binary
SHA-256. Run desktop dev, full Rust tests, sidecar staging, and a dry-run
release package. Adopt only if outputs stay private and median clean/warm
results improve materially (suggested gate: at least 15% disk reduction with
no more than 5% warm-build regression).

Rollback: remove the target default; explicit sidecar `--target` remains.
Existing isolated artifacts become unused cache entries and can be cleaned.

### Phase 4: Integrate the cache only if the canary passes

**Entry condition:** Phase 2 passes every correctness, physical-disk, build
time, and privacy gate on the full Kanna graph.

**Current status:** entry condition not met for kache 0.10.0. Do not implement
this phase.

Implementation boundaries:

- Add a committed kache tool manifest and checksum verifier to `kd` setup.
- Store the tool and cache under Kanna-owned cache directories, not the repo
  and not Homebrew.
- Enable with an explicit Kanna dev-cache setting/canary flag.
- Add the minimal dependency-only dispatcher with unit tests for path
  classification, malformed arguments, spaces/symlinks, and fallback.
- Keep `.build/cargo-build` private.
- Keep Kanna workspace incremental compilation enabled by sending those units
  directly to rustc.
- Force local-only configuration, a per-repository store, a 10 GiB cap, and
  user-facing executable caching off.
- Surface direct-rustc fallback in `kd` logs and status.

Acceptance matrix:

| Change between build A and B | Expected B result |
| --- | --- |
| identical source in different Kanna worktree roots | cache hits for cacheable dependencies |
| one workspace source change | miss only affected cacheable units/dependents |
| feature set change | distinct key and correct output |
| `RUSTFLAGS` change | distinct key and correct output |
| implicit host versus explicit target | distinct/correct artifacts |
| target triple change | distinct key and architecture |
| rustc version change | distinct key |
| concurrent worktrees | no cross-output, corruption, or serialization on Cargo build dir |
| full cache or evicted entry | correct compile fallback |
| unavailable/crashed kache | direct rustc succeeds with warning |

Performance gate on a full Kanna workload:

- at least 70% cache-hit rate for identical third-party dependency builds in a
  fresh sibling worktree
- at least 30% median wall-time improvement after local Cargo-cache eviction
- aggregate physical Cargo allocations plus kache remain under the configured
  budget
- no regression in warm edit/rebuild above 10%

Release portability gate:

1. Put executables named `kache` and `sccache` that exit nonzero at the front
   of PATH.
2. Remove the Kanna-managed kache binary/cache.
3. Run canonical release dry-run/build verification.
4. Assert no wrapper invocation and no packaged/staged path outside the
   checkout-private `.build` and Tauri staging directories.

Rollback: unset the cache feature and wrapper environment. Because Cargo's
build-dir never moved, builds immediately continue from isolated state. The
kache directory can be deleted later with an explicit exact-path cleanup.

## Migration and rollback

There is no Cargo-layout migration. Existing worktrees keep their current
`.build` target directory and `.build/cargo-build` build directory. Do not copy,
hard-link, import, or pre-seed any existing Cargo artifact into the content
cache.

Rollout, if the canary passes:

1. Ship the verified cache tool and dependency-only dispatcher behind an
   explicit development setting, default off.
2. Enable it for one repository and a small set of `kd`-managed commands. Do
   not modify checked-in Cargo config or ambient user shell configuration.
3. Let ordinary builds populate the per-repository content store. Existing
   private build trees remain valid and may produce fewer wrapper calls until
   Cargo naturally recompiles units.
4. Expand the canary only after status reports show correct classifications,
   bounded storage, useful hit rates, and no edit-loop regression.
5. Keep the existing worktree teardown policy unchanged. It can delete a
   departed private build tree without invalidating the shared content store.

Immediate rollback is to disable the setting and remove
`RUSTC_WRAPPER`/`RUSTC_WORKSPACE_WRAPPER` plus `KACHE_*` variables from the
spawned command environment. The next Cargo command uses direct rustc and the
same private build tree. Cache entries are never authoritative, so the shared
store may be removed later by an explicit exact-path operation after confirming
that no wrapper process is active. Release builds require no migration or
rollback because they never opt into this path.

## Rejected shortcuts

- **Restore the old global path with a Cargo lock:** rejected because the
  silent stale result reproduced sequentially.
- **Scope one raw build-dir per repository:** rejected for the same reason;
  branches/worktrees still have distinct sources and identical Cargo unit
  names.
- **Add only `{workspace-path-hash}` and call it sharing:** correct but does
  not deduplicate bytes.
- **Install sccache with Homebrew:** violates Kanna's build-machine
  independence and does not solve released sccache's Rust worktree misses.
- **Check in `rustc-wrapper = "sccache"`:** makes ordinary and release Cargo
  commands depend on PATH state and turns an accelerator into a requirement.
- **Check in `rustc-wrapper = "kache"`:** has the same portability problem and
  also disables incremental compilation for every Kanna workspace crate. The
  dependency-only dispatcher and explicit opt-in are required boundaries.
- **Disable incremental globally now:** reclaims meaningful disk but can make
  interactive local edits worse, while released sccache cannot compensate in
  sibling worktrees.
- **Delete current worktree caches automatically by age:** unsafe while users
  can run manual shells or Cargo outside Kanna's known PTY session. Start with
  departed workspaces and explicit cleanup.
- **Copy Bazel outputs into Cargo's build directory:** rejected because the two
  systems have different action/fingerprint models. Use Bazel outputs as final
  Bazel products; do not use them to seed `.build/cargo-build`.
- **Extend Bazel into interactive development only to obtain cache reuse:**
  rejected because Kanna intentionally keeps Tauri CLI/Vite development
  separate from deterministic Bazel release assembly. This would replace dev
  orchestration, HMR/dev-URL behavior, and E2E assumptions rather than merely
  change a cache layer.

## Source links

- [Cargo build cache reference](https://doc.rust-lang.org/cargo/reference/build-cache.html)
- [Cargo `build.build-dir` configuration](https://doc.rust-lang.org/cargo/reference/config.html#buildbuild-dir)
- [Cargo proposal for hashed global build dirs](https://github.com/rust-lang/cargo/issues/16147)
- [Rust/Cargo build-dir layout v2 testing call](https://blog.rust-lang.org/2026/03/13/call-for-testing-build-dir-layout-v2/)
- [Bazel remote/disk cache architecture and garbage collection](https://bazel.build/remote/caching)
- [sccache README and Rust caveats](https://github.com/mozilla/sccache)
- [sccache configuration and cache size controls](https://github.com/mozilla/sccache/blob/v0.14.0/docs/Configuration.md)
- [sccache 0.16.0 release assets](https://github.com/mozilla/sccache/releases/tag/v0.16.0)
- [Rust `SCCACHE_BASEDIRS` gap](https://github.com/mozilla/sccache/issues/2652)
- [Open Rust path-normalization implementation](https://github.com/mozilla/sccache/pull/2678)
- [Dynamic git-worktree base-directory gap](https://github.com/mozilla/sccache/issues/2595)
- [kache repository and architecture overview](https://github.com/kunobi-ninja/kache)
- [kache 0.10.0 release assets](https://github.com/kunobi-ninja/kache/releases/tag/v0.10.0)
- [kache cache-key model](https://github.com/kunobi-ninja/kache/blob/v0.10.0/docs/how-it-works/cache-key.mdx)
- [kache APFS reflink deduplication](https://github.com/kunobi-ninja/kache/blob/v0.10.0/docs/deduplication.mdx)
- [kache configuration and limits](https://github.com/kunobi-ninja/kache/blob/v0.10.0/docs/getting-started/configuration.mdx)
- [Kanna PR #686](https://github.com/tampopogk/kanna/pull/686)
