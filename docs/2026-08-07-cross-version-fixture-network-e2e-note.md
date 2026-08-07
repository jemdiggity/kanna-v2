# Cross-version daemon fixture: no network at test time

**Date:** 2026-08-07

## What broke

`./kd test all` failed in `kanna-daemon --test handoff` with
`Recv failure: Operation timed out`. Nothing was wrong with the daemon: the
cross-version fixture in `crates/daemon/tests/support/previous_daemon.rs` was
cloning `https://github.com/jemdiggity/ghostty.git` *while the test lane ran*,
and GitHub timed out.

The clone was never written into the fixture. It came out of
`vendor/libghostty-rs/crates/libghostty-vt-sys/build.rs`, which fetches the
pinned ghostty source into its own `OUT_DIR` whenever `GHOSTTY_SOURCE_DIR` is
unset. The fixture compiles the archived `v0.1.0-staging.1` daemon in a
*private* Cargo tree — deliberately, so two source revisions never share one
fingerprint tree — which means a private `OUT_DIR`, which means a second full
ghostty clone the first time any worktree runs the handoff suite.

## The invariant now

The fixture resolves a ghostty checkout locally and passes it to the nested
build as `GHOSTTY_SOURCE_DIR`:

1. an inherited `GHOSTTY_SOURCE_DIR`, if it holds a `build.zig`; else
2. the checkout the *current* build already materialized, found under the
   running test binary's own Cargo `build` directory
   (`libghostty-vt-sys-*/out/ghostty-src`) and accepted only when its
   `.ghostty-commit` stamp matches the commit the archive pins.

Nothing is fetched. The archived source comes from this repository's own object
database via `git archive`, and the ghostty source is one the workspace build
already paid for — the test binary could not have linked without it.

If neither resolves, the four cross-version tests print a `SKIP` line naming
the test, the invariants that went unexercised, and the three ways to supply a
source, then return. They do not fall back to a clone, and they do not fail the
lane on a network condition. The other 18 handoff tests never needed the
fixture and are unaffected.

The notice is written straight to fd 2 through `std::io::Stderr`, not with
`eprintln!`. libtest's capture is installed by `set_output_capture`, which
diverts only the `print!`/`eprintln!` macro path, and it then discards a
*passing* test's captured output — so a skip announced with `eprintln!` shows
up only under `--nocapture`, which no lane passes. Skipping quietly is the
failure mode that matters here: these four tests are the only cover for the
cross-version handoff invariants in `crates/daemon/SPEC.md`, and a future
ghostty bump would make `checkout_in` reject the stamp and take the whole set
out with nothing in the log to say so.

## What is and is not covered by test

Covered: **the skip notice reaches a run that captures test output**.
`the_skip_notice_survives_a_run_that_captures_test_output` in
`crates/daemon/tests/fixture_isolation.rs` re-executes its own test binary with
`KANNA_PREVIOUS_DAEMON_FORCE_MISSING=1` — a test-only hook that forces the
unresolvable-checkout condition — filtered to one `#[ignore]`d child test, with
`--test-threads=1` and *without* `--nocapture`, and asserts the notice is in
the child's combined output and the child exited 0. The property lives in a
child libtest process's output stream, which is why it is an integration test
spawning a real one rather than a unit test on the notice. No network is
involved. Reverting the notice to `eprintln!` fails it.

Not covered: **the lane makes no network call**. A lane cannot prove that about
itself — asserting it requires taking the network away, which is an environment
change, not an assertion. A test that merely checks `GHOSTTY_SOURCE_DIR` is set
on the nested command would restate the implementation rather than test the
property. What would make it testable: a sandboxed test lane with egress denied
by default. Until then the first reproduction below is the check, and it is
cheap.

## Reproductions

Both use the daemon lane's own flags (`tools/kd/src/runtime/rust-test.ts`), so
neither passes `--nocapture`.

**No network, checkout present.** Cold fixture cache, GitHub rewritten to an
unroutable address for every `git` subprocess the build spawns:

```sh
rm -rf .build/daemon-cross-version
GIT_CONFIG_COUNT=1 \
GIT_CONFIG_KEY_0='url.https://127.0.0.1:1/.insteadOf' \
GIT_CONFIG_VALUE_0='https://github.com/' \
  cargo test -p kanna-daemon --test handoff -- --test-threads=1
```

Verified 2026-08-07: the fixture rebuilt from the local checkout, 22 passed,
0 failed, nothing fetched.

**No network, no checkout.** Move every
`.build/cargo-build/debug/build/libghostty-vt-sys-*/out/ghostty-src` aside —
match on the glob rather than a count, since only the build directory that
*ran* the build script has an `out/`, and the one holding the build-script
executable does not — clear the fixture cache, and run the same command. The
four cross-version tests skip and the run still reports 22 passed, with each
skip printing its `SKIP` line **in the ordinary output, no `--nocapture`
needed**. Restore the directories afterwards.

Adding `--nocapture` changes nothing here. It turns off the capture that the
notice already bypasses; it would only additionally reveal output written with
`eprintln!`, which is precisely what the notice no longer uses.
