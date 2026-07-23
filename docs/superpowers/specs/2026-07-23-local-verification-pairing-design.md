# Local Verification and Pairing Boundary Design

**Goal:** Replace GitHub-hosted test automation with one canonical local verification command while fixing the locally reproducible pairing-boundary failure and keeping macOS process coverage deterministic.

## Context and Root Causes

Kanna is distributed as a signed macOS app and does not support Linux. The Ubuntu Rust job executes macOS desktop process-management code in an environment that does not provide the same system paths. Its `/usr/sbin/lsof` failure is therefore a CI-platform mismatch, not a production portability defect. Changing shipped desktop code to support an unsupported runner would put the compatibility concern at the wrong boundary.

The SIGTERM-escalation regression test still has a real local determinism problem: it chooses a free port by binding and releasing it before starting its child listener. That creates an avoidable allocation race and uses process inspection rather than an explicit child-ready signal.

The cloud pairing Remote E2E test creates a pairing session with `RelayDesktopClient.invokeDesktop`. That request is an authenticated phone relay tunnel and is marked with `TunneledHttpInvoke`. Production correctly rejects it because pairing-session creation is restricted to loopback, non-tunneled desktop requests. The remote harness already exposes the server's loopback base URL, so the test is calling the wrong boundary rather than missing relay authentication.

The scheduled Remote E2E preflight also has a Linux-only `command` executable failure. Removing the unsupported GitHub runner eliminates that false boundary. Local macOS doctor behavior is unchanged.

## Design

### Canonical local verification

Add `./kd test ci` as the single local equivalent of the removed GitHub verification. It runs these existing canonical surfaces sequentially:

1. `pnpm test`
2. `./kd test rust`
3. `./kd test remote-e2e`

The steps are sequential because Rust and Remote E2E share workspace build artifacts and process resources. The command stops at the first failure, preserves that command's output, and returns a failing status. It does not run staging, production, physical-device, release, deployment, or credentialed tests.

Delete `.github/workflows/ci.yml` and `.github/workflows/remote-e2e.yml`. Keep `.github/workflows/config-schema-pages.yml` because it publishes generated documentation rather than acting as a test gate. Remove or update tests and documentation that assert the deleted workflows exist, and document `./kd test ci` as the pre-review/pre-release local gate.

### Deterministic macOS server process test

Keep `/usr/sbin/lsof` unchanged because it is the correct system path on the only supported desktop platform. Do not add Linux path resolution or claim Linux desktop compatibility.

Make the escalation test's Python listener bind to loopback port `0`, print the kernel-assigned port only after `listen` succeeds, and flush stdout. The Rust parent reads that line with a timeout. This removes the bind-release-bind race and gives an explicit readiness handshake. Configure the child to be killed on drop so a failed assertion cannot leave a SIGTERM-ignoring process behind.

### Desktop-only pairing in Remote E2E

Add a harness operation named for its authority, `createDesktopPairingSession`, which sends `POST /v1/pairing/sessions` directly to the harness's loopback `lanBaseUrl`. Validate the HTTP status and minimum pairing response shape before returning it.

Use that operation only for the cloud test's desktop bootstrap. Continue using the relay client for the phone-visible status, discovery, and authentication assertions. Do not modify the production pairing route, add an authorization header, or add a test bypass. Existing server tests must continue proving that non-loopback and tunneled creation requests return HTTP 403.

## Error Handling

The local CI orchestrator reports which phase failed and forwards its output. It must not continue into later phases after a failure.

Failure to launch macOS `lsof` remains a hard server-cleanup error with the original contextual message. A failed listener readiness handshake must terminate the child and report whether the child exited, produced invalid port output, closed stdout, or timed out.

The harness pairing operation must include the HTTP status and response body in failures.

## Testing and Verification

Use test-driven changes:

- Update the SIGTERM-ignoring listener test to use its explicit kernel-assigned-port readiness handshake, then run the focused desktop Rust test.
- Add harness unit coverage that the desktop pairing operation calls the direct loopback URL, and retain server authorization coverage for relay rejection.
- Add CLI/task tests proving `./kd test ci` resolves to the local CI task, runs the three phases in order, and stops after a failed phase.
- Update workflow inventory tests to prove GitHub-hosted verification is absent while Config Schema Pages remains.
- Reproduce the cloud pairing Remote E2E spec locally and verify it reaches the full relay assertions without a pairing 403.

Final canonical verification is:

```bash
./kd test ci
```

Also run focused process cleanup, local-CI orchestration, and pairing authorization tests before the full local gate.
