# kache cache-key selection: E2E gap

**Date:** 2026-08-02<br>
**Status:** Closed for cross-revision selection, 2026-08-02. Narrowed, not
eliminated — see "What the closure does and does not cover". The Rust compiler
cache is now on by default; `KANNA_RUST_CACHE=off` is the escape hatch.

## Correction first: the E0432 incident was not a kache defect

Two `./kd test all` runs failed in the `kanna-daemon` doctest:

```text
error[E0432]: unresolved import `kanna_runtime_defaults::session_id`
  --> crates/daemon/src/lib.rs:18:9
```

This was attributed to kache serving a logically stale entry. **That attribution
was wrong, and the evidence that settles it is that the failure reproduces with
the cache disabled.**

The actual cause was in this repository's own test suite — in **two independent
fixtures**, both leaking the same way. Cargo resolves `CARGO_TARGET_DIR`,
`CARGO_BUILD_TARGET_DIR`, and `CARGO_BUILD_BUILD_DIR` from the environment
*before* a checkout's `.cargo/config.toml`, and `kd` exports
`CARGO_BUILD_BUILD_DIR` for every worktree:

1. **`tools/kd/tests/rust-cache.integration.test.ts`** compiled its disposable
   Cargo fixtures with an inherited `process.env`, so they wrote into **the real
   repository's `.build/cargo-build`**. Measured: running that file with the
   variable set left **19 foreign probe crates in the repository's
   `debug/deps`**.
2. **`crates/daemon/tests/support/previous_daemon.rs`** builds an archived
   previous release (`v0.1.0-staging.1`) in a nested Cargo process. It set its
   own `CARGO_TARGET_DIR` but *inherited* `CARGO_BUILD_BUILD_DIR`, so the
   archive — whose `crates/runtime-defaults/src/lib.rs` has no `session_id`
   module — wrote `dep-lib-kanna_runtime_defaults` and
   `libkanna_runtime_defaults-b7a37aed3c6a9c04.rlib` into the active worktree's
   build directory. This is the leak that actually produced the observed
   `E0432`: the archive and the current sources are genuinely *different source
   revisions of the same crate*, sharing one fingerprint tree.

The second fixture was missed on the first pass because its build is cached at
`.build/daemon-cross-version/<commit>-<os>-<arch>/target/debug/kanna-daemon`; once
that binary exists the nested build is skipped, so a verification run that does
not clear it cannot observe the leak.

That is precisely the shared-build-dir hazard documented in
[`docs/specs/safe-rust-build-caching.md`](specs/safe-rust-build-caching.md) — two
unrelated source roots in one Cargo fingerprint tree, which on Cargo 1.93.1
silently returns stale artifacts while reporting units as `Fresh`. It explains
every observation:

- `./kd test all` runs `pnpm test` (which runs those tests) *before* the rust
  lane, so the rust lane always built against a poisoned tree.
- The failure never reproduced when the rust lane ran alone.
- A cold-tree rebuild always produced the correct rlib.
- The same Cargo unit hash `b7a37aed3c6a9c04` yielded an 859 KiB rlib with no
  `session_id` symbols during `./kd test all`, and a correct 975 KiB rlib with
  them after `cargo clean -p kanna-runtime-defaults`.

Both are fixed the same way — remove every inherited spelling, then apply the
fixture's own private paths:

- `isolatedCargoEnv()` in `tools/kd/tests/rust-cache.integration.test.ts`.
- `isolated_cargo_build()` in `crates/daemon/tests/support/previous_daemon.rs`,
  which now clears all three variables and sets a fixture-private
  `CARGO_TARGET_DIR` **and** `CARGO_BUILD_BUILD_DIR`.

With both isolated, a cold `./kd test all` leaves zero foreign crates in the
repository's `debug/deps`. Regression tests cover each: a kd integration test
asserts a fixture's `cargo metadata` resolves inside the fixture even when a
shared directory is exported, and `crates/daemon/tests/fixture_isolation.rs`
drives real nested Cargo builds asserting an outer build/target directory stays
empty and that an archived older revision cannot break a later current-source
build. Both were verified to fail when the isolation is reverted.

### What this means for the earlier diagnosis

A review diagnostic observed kache serving key `e32d03ef3851f383` while the
correct current-source entry `d14e9a65ec856b5b` was present, with
`kache doctor --verify --checksums` reporting 1200/1200 entries valid. That
observation is real, but it was made in a tree already poisoned by the leak, and
it is consistent with kache faithfully caching and restoring what Cargo asked
for: kache keys off the rustc invocation and the dep-info Cargo produces, so
corrupted fingerprint state yields a wrong-but-self-consistent key. It is not
evidence of a kache key-selection bug.

It is also not proof that kache's selection is *sound*. That is the gap below.

## The gap as originally stated

Kanna had no automated test that exercised the **real pinned `kache` binary**
across two source revisions and asserted that an artifact compiled from the older
revision is never selected for the newer one. Nothing suggested that boundary was
broken, but nothing in canonical automation demonstrated it held either — and a
single hand-run probe (a `defaults` crate gaining a `session_id` module, a
`consumer` crate re-exporting it, cold private tree against a warm store) is not
a proof.

The stated obstacle was tool provisioning: exercising the real binary appeared to
require a network download of the pinned release, which `pnpm test` and
`./kd test all` deliberately do not do.

## How it was closed

The obstacle was mis-stated. The *test* never needed to download anything —
`./kd rust-cache install` does, and it runs from this repository's `setup` list.
More to the point, the pinned binary's presence is the same condition as the
cache being able to affect a build at all: when it is absent,
`applyRustCacheEnvironment` resolves `not-installed` and falls back to direct
rustc. So a suite gated on the installed binary is not a coverage hole — it runs
wherever the risk exists, and skips exactly where there is none.

`tools/kd/tests/rust-cache.integration.test.ts` now contains, under
**`pinned kache selects cache keys per source revision`**:

- **`never serves an artifact compiled from a different revision`** — the
  incident's own shape, driven through the real binary in five builds, each from
  a cold private tree against a progressively warmer store. It populates the
  store at revision 1; rebuilds revision 1 cold and asserts a hit, so nothing
  after that can pass vacuously; advances to revision 2, where a stale selection
  fails with `E0432: unresolved import ...session_id`; rebuilds revision 2 cold
  and asserts it restores *its own* entry, so the previous step cannot be
  satisfied by a cache that never hits; and finally reverts to revision 1, the
  direction that compiles cleanly against a revision-2 archive and is caught only
  because the fixture's executable prints which revision it was linked against.
- **`keys on the compiler invocation, not only on the sources`** — identical
  sources under different `RUSTFLAGS` must not share an entry.

The store is disposable: the fixture home symlinks the pinned tool root, so the
real binary runs while `KACHE_CACHE_DIR` resolves under the fixture's own home
and no developer's store is read or written.

The negative control moved rather than disappeared. The former
`does not restore a revision-1 artifact into a revision-2 build` asserted that
the *default* never reached the cache, which the flipped default makes
meaningless. It is now
**`fails with E0432 when the cache serves a revision-1 artifact to revision 2`**:
it installs a deliberately mis-selecting cache at the pinned path and asserts the
fixture fails loudly with the incident's exact signature. Without it, "the real
binary passed" would only establish that the probe is insensitive.

### `./kd test all` is itself a cross-revision check on the real graph

Worth knowing, because it was not designed as one. The daemon's previous-release
fixture (`crates/daemon/tests/support/previous_daemon.rs`) compiles the archived
`v0.1.0-staging.1` tree in a nested Cargo process. `isolated_cargo_build()` gives
it private target and build directories — that was the E0432 fix — but it
inherits `RUSTC_WRAPPER` and `KACHE_CACHE_DIR` from the kd environment, as it
should. So with the cache on by default, every `./kd test all` compiles two
genuinely different revisions of `kanna-runtime-defaults` (the archive has no
`session_id`; current sources do) through one shared content store, and then runs
the daemon doctest where the original failure surfaced.

Verified on this change, from a cold `.build/cargo-build` **and**
`.build/daemon-cross-version`: the run passed end to end, and the store holds
three distinct `kanna_runtime_defaults` entries of different sizes, all reachable
within it. The only `E0432` anywhere in the log is the negative control asserting
its own.

This is real-graph evidence, not a substitute for the tests above — it is
incidental to the fixture's design and would stop being true if the fixture
started scrubbing the wrapper. Do not treat it as the coverage; treat it as a
reason to look hard at any future change that isolates the fixture further.

## What the closure does and does not cover

Covered: cross-revision source selection in both directions, against the real
pinned binary, with restore liveness and probe sensitivity both proven rather
than assumed; and rustflags key separation.

Not covered, and narrower than the original gap:

- Feature-set, target-triple, and toolchain-version discrimination. These were
  measured by hand during the canary and are not automated.
- The full Kanna graph through the real binary. The fixture is a two-crate
  workspace; the shipped measurements on the real sidecar graph are in
  `docs/specs/safe-rust-build-caching.md`, but they are measurements, not
  assertions.
- The provisioning path itself — download, checksum, version check — is unit
  tested with a fake runner, not exercised against the network.
- CI. The cache is disabled there outright, so the suite skips; that is
  consistent, not a hole.

## Why the default is on

The measured trade was accepted: a cold private tree against a warm store
restores 96.5% of cacheable invocations and cuts sidecar build CPU by 56%, and
the private build tree shrinks 41% per worktree, while a one-line workspace edit
rebuilds several times slower — re-measured at the new default as 5.47 s to
15.87 s wall and 7.4x the CPU. That is a product call about which cost to pay,
made with the root cause of the E0432 incident known and the key-selection
boundary now covered by test rather than by argument.

`KACHE_VERIFY_RESTORES=always` stays on. It guarantees a restored blob matches
the digest recorded for the key kache chose — it never proved the key was the
right one, and now does not need to. It is defence in depth against a corrupt or
truncated entry, and must not be traded for restore speed.

## Regression coverage added meanwhile

`tools/kd/tests/rust-cache.integration.test.ts`, using real Cargo and a real
filesystem:

- **`strips inherited Cargo build/target directories`** and **`compiles a fixture
  into the fixture's own build directory`** — the guard for the actual defect
  above.
- **`fails with E0432 when the cache serves a revision-1 artifact to revision 2`**
  — builds a two-crate workspace at revision 1, records its `.rlib` *and*
  `.rmeta`, installs a stub cache at the pinned path that restores those over
  every later `defaults` compile, advances the sources, and builds with the
  default resolution. It asserts the build fails with
  `error[E0432]: unresolved import kd_probe_defaults::session_id`, which is what
  makes it the sensitivity control for the real-binary suite. Both metadata and
  archive are restored by the stub because rustc resolves imports from `.rmeta`;
  overwriting only the archive is invisible to a normal build, which is why the
  original failure surfaced in rustdoc, where the rlib is linked.
- **`opting out of an inherited active environment restores incremental
  compilation`** — proves `KANNA_RUST_CACHE=off` inside a kd-spawned shell really
  reverts to direct incremental builds.

`crates/daemon/tests/fixture_isolation.rs`, driving real nested Cargo builds:

- **`nested_fixture_build_leaves_the_outer_cargo_directories_untouched`** —
  exports all three directory variables the way a kd worktree does, runs a build
  through `isolated_cargo_build()`, and asserts the outer build and target
  directories stay empty.
- **`an_older_archive_cannot_poison_a_later_current_source_build`** — builds an
  archived revision without `session_id` and then a current revision that needs
  it, in that order, against an exported shared build directory; the current
  build must succeed. Reverting the isolation makes both fail with
  "wrote into the outer/shared Cargo build directory".

Unit coverage in `rust-cache.test.ts` and `rust-cache-policy.test.ts` pins the
default-on resolution, the enabled→off transition, the fallback to direct rustc
when the pinned tool is absent (the condition the real-binary suite is gated on),
`KACHE_VERIFY_RESTORES=always`, ambient `KACHE_DISABLED`, hostile
`RUSTC_WORKSPACE_WRAPPER` / `CARGO_BUILD_RUSTC_*` wrappers, and idempotence.
`release-env.test.ts` pins release stripping of every wrapper spelling.

## Existing worktrees

Any worktree that ran either fixture before this fix may hold foreign crates and
a poisoned fingerprint tree in `.build/cargo-build`, and Cargo will consider
those units fresh. Run `./kd clean --all` once in such a worktree.

When verifying this specifically, clear **both** caches first — the private build
tree *and* the previous-daemon fixture binary — or the nested build is skipped
and the leak cannot reappear:

```sh
rm -rf .build/cargo-build .build/daemon-cross-version
./kd test all
```
