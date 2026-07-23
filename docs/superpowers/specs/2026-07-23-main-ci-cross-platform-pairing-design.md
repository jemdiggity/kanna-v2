# Main CI Cross-Platform and Pairing Boundary Design

**Goal:** Restore the Rust and Remote E2E CI lanes on `main` without weakening desktop-only pairing authorization or introducing build-machine dependencies into the signed macOS app.

## Context and Root Causes

The Ubuntu Rust job fails when desktop mobile-server cleanup runs `/usr/sbin/lsof`. That absolute path is the macOS system location; Linux provides `lsof` through `PATH`, typically as `/usr/bin/lsof`. The first cleanup failure can occur while a test holds the process-wide environment lock, poisoning that lock and producing unrelated cascading failures.

The SIGTERM-escalation regression test also chooses a free port by binding and releasing it before starting its child listener. That creates an avoidable allocation race and uses the same `lsof` inspection path to decide whether the child is ready.

The cloud pairing Remote E2E test creates a pairing session with `RelayDesktopClient.invokeDesktop`. That request is an authenticated phone relay tunnel and is marked with `TunneledHttpInvoke`. Production correctly rejects it because pairing-session creation is restricted to loopback, non-tunneled desktop requests. The remote harness already exposes the server's loopback base URL, so the test is calling the wrong boundary rather than missing relay authentication.

The latest scheduled Remote E2E run has an earlier Linux-only blocker: its doctor tries to spawn `command`, a shell builtin, as an executable. macOS happens to provide `/usr/bin/command`; Ubuntu does not. This prevents the scheduled lane from reaching its tests.

## Design

### Cross-platform server process inspection

Keep the packaged macOS path deterministic by resolving `lsof` to `/usr/sbin/lsof` on macOS. Resolve it as `lsof` on other supported Unix test platforms so normal `PATH` lookup finds the platform installation. Put this choice behind a small pure helper with direct regression coverage for macOS and Linux.

Do not replace `lsof` with a new native process-discovery subsystem. Kanna ships as a macOS application, where `/usr/sbin/lsof` is a system binary; the non-macOS path supports CI and development without changing release dependencies.

Make the escalation test's Python listener bind to loopback port `0`, print the kernel-assigned port only after `listen` succeeds, and flush stdout. The Rust parent reads that line with a timeout. This removes the bind-release-bind race and gives an explicit readiness handshake. Configure the child to be killed on drop so a failed assertion cannot leave a SIGTERM-ignoring process behind.

### Desktop-only pairing in Remote E2E

Add a harness operation named for its authority, `createDesktopPairingSession`, which sends `POST /v1/pairing/sessions` directly to the harness's loopback `lanBaseUrl`. Validate the HTTP status and minimum pairing response shape before returning it.

Use that operation only for the cloud test's desktop bootstrap. Continue using the relay client for the phone-visible status, discovery, and authentication assertions. Do not modify the production pairing route, add an authorization header, or add a test bypass. Existing server tests must continue proving that non-loopback and tunneled creation requests return HTTP 403.

### Portable Remote E2E preflight

Keep `tools/kd/src/runtime/doctor.ts` as the shared command-availability implementation. Run `command -v "$1"` through `/bin/sh`, passing each fixed command name as a positional argument rather than interpolating it into shell source. This works on both macOS and Ubuntu and preserves `CommandRunner` testability.

Change `tests/remote-e2e/src/doctor.ts` to consume `checkRequiredCommands` instead of duplicating command lookup. Convert its returned availability entries into the existing preflight report format, leaving port, credential, relay, and Firebase checks unchanged.

## Error Handling

Failure to launch `lsof` remains a hard server-cleanup error with the original contextual message. A failed listener readiness handshake must terminate the child and report whether the child exited, produced invalid port output, closed stdout, or timed out.

The harness pairing operation must include the HTTP status and response body in failures. The doctor must report missing commands as failed checks rather than throwing because a shell builtin was spawned incorrectly.

## Testing and Verification

Use test-driven changes:

- Add pure Rust coverage proving macOS selects `/usr/sbin/lsof` and Linux selects `lsof`.
- Update the SIGTERM-ignoring listener test to use its explicit kernel-assigned-port readiness handshake, then run the focused desktop Rust test.
- Add harness unit coverage that the desktop pairing operation calls the direct loopback URL, and retain server authorization coverage for relay rejection.
- Update doctor tests to prove `/bin/sh` command lookup and remote-preflight reuse.
- Reproduce the cloud pairing Remote E2E spec locally and verify it reaches the full relay assertions without a pairing 403.

Final canonical verification is:

```bash
pnpm test
./kd test rust
pnpm --dir tests/remote-e2e exec vitest run --no-file-parallelism --maxWorkers=1 --maxConcurrency=1 --hookTimeout=240000 --testTimeout=120000 src/cloud-pairing-auth-discovery.e2e.test.ts
```

Also run focused doctor, process cleanup, and pairing authorization tests before the full suites.
