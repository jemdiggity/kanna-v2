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
the test and the three ways to supply a source, and return. They do not fall
back to a clone, and they do not fail the lane on a network condition. The
other 18 handoff tests never needed the fixture and are unaffected.

## Why this has no automated test

The property is "the test lane makes no network call", and a lane cannot prove
that about itself: asserting it requires taking the network away, which is an
environment change, not an assertion. A test that merely checks
`GHOSTTY_SOURCE_DIR` is set on the nested command would restate the
implementation rather than test the property.

What would make it testable: a sandboxed test lane with egress denied by
default. Until then, the reproduction below is the check, and it is cheap.

## Reproduction

Cold fixture cache, GitHub rewritten to an unroutable address for every `git`
subprocess the build spawns:

```sh
rm -rf .build/daemon-cross-version
GIT_CONFIG_COUNT=1 \
GIT_CONFIG_KEY_0='url.https://127.0.0.1:1/.insteadOf' \
GIT_CONFIG_VALUE_0='https://github.com/' \
  cargo test -p kanna-daemon --test handoff -- --test-threads=1
```

Verified 2026-08-07: 22 passed, 0 failed. Hiding the workspace's
`libghostty-vt-sys-*/out/ghostty-src` and rerunning the same command yields 22
passed with the four cross-version tests printing their `SKIP` line.
