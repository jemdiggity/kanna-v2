# kache cache-key selection: E2E gap

**Date:** 2026-08-02<br>
**Status:** Open. The Rust compiler cache is opt-in (`KANNA_RUST_CACHE=on`).

## Correction first: the E0432 incident was not a kache defect

Two `./kd test all` runs failed in the `kanna-daemon` doctest:

```text
error[E0432]: unresolved import `kanna_runtime_defaults::session_id`
  --> crates/daemon/src/lib.rs:18:9
```

This was attributed to kache serving a logically stale entry. **That attribution
was wrong, and the evidence that settles it is that the failure reproduces with
the cache disabled.**

The actual cause was in this repository's own test suite. Cargo resolves
`CARGO_BUILD_BUILD_DIR` from the environment *before* a checkout's
`.cargo/config.toml`, and `kd` exports that variable for every worktree.
`tools/kd/tests/rust-cache.integration.test.ts` compiled its disposable Cargo
fixtures with an inherited `process.env`, so those fixtures wrote their
intermediates into **the real repository's `.build/cargo-build`**. Measured
directly: running that file with the variable set left **19 foreign probe crates
in the repository's `debug/deps`**.

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

The fix is `isolatedCargoEnv()` in that test file, which strips
`CARGO_BUILD_BUILD_DIR`, `CARGO_BUILD_TARGET_DIR`, and `CARGO_TARGET_DIR` from
every fixture build. After it, the same run leaks **zero** foreign crates and a
regression test asserts a fixture's `cargo metadata` reports a build directory
inside the fixture even when a shared one is exported.

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

## What is still not covered

Kanna has no automated test that exercises the **real pinned `kache` binary**
across two source revisions and asserts that an artifact compiled from the older
revision is never selected for the newer one. Nothing now suggests that boundary
is broken, but nothing in canonical automation demonstrates it holds either.

Exercising the real binary in canonical automation requires a network download
of the pinned release, which `pnpm test` and `./kd test all` deliberately do not
do. Closing this gap means solving the tool-provisioning problem, and then
driving two source revisions plus a warm shared store through a real build.

A targeted probe against the real pinned binary — a `defaults` crate gaining a
`session_id` module, a `consumer` crate re-exporting it, cold private tree
against a warm store — compiled correctly with zero hits. One passing probe is
not a proof.

## Why the default is still off

The correction above removes the demonstrated reason to distrust kache, but it
does not by itself establish the positive case, and the incident that prompted
adoption review is only now understood. The cache stays opt-in
(`KANNA_RUST_CACHE=on`) until someone decides deliberately to flip it, with the
root cause known and the measured trade in hand: a cold private tree against a
warm store restores 96.5% of cacheable invocations and cuts sidecar build CPU by
56%, while a one-line workspace edit rebuilds about 3.5x slower. That is a
product call, not a correctness blocker.

## Regression coverage added meanwhile

`tools/kd/tests/rust-cache.integration.test.ts`, using real Cargo and a real
filesystem:

- **`strips inherited Cargo build/target directories`** and **`compiles a fixture
  into the fixture's own build directory`** — the guard for the actual defect
  above.
- **`does not restore a revision-1 artifact into a revision-2 build`** — builds a
  two-crate workspace at revision 1, records its `.rlib` *and* `.rmeta`, installs
  a stub cache that restores those over every later `defaults` compile, advances
  the sources, and builds with the default resolution. The build runs before the
  assertions, so a regression shows up as its consequence: flipping the default
  on makes this fail with
  `error[E0432]: unresolved import kd_probe_defaults::session_id`. Both metadata
  and archive are restored by the stub because rustc resolves imports from
  `.rmeta`; overwriting only the archive is invisible to a normal build, which is
  why the original failure surfaced in rustdoc, where the rlib is linked.
- **`opting out of an inherited active environment restores incremental
  compilation`** — proves `KANNA_RUST_CACHE=off` inside a kd-spawned shell really
  reverts to direct incremental builds.

Unit coverage in `rust-cache.test.ts` and `rust-cache-policy.test.ts` pins the
opt-in default, the enabled→off transition, ambient `KACHE_DISABLED`, hostile
`RUSTC_WORKSPACE_WRAPPER` / `CARGO_BUILD_RUSTC_*` wrappers, and idempotence.
`release-env.test.ts` pins release stripping of every wrapper spelling.

## Existing worktrees

Any worktree that ran the integration tests before this fix may hold foreign
crates and a poisoned fingerprint tree in `.build/cargo-build`, and Cargo will
consider those units fresh. Run `./kd clean --all` once in such a worktree.
