# Cloud Terminal Auth E2E Gap

The current `apps/desktop/tests/e2e/real/cloud-task-sync.test.ts` harness cannot prove the full saved desktop identity -> credential publish -> relay/server auth path yet.

The blocker is the local E2E runner: `apps/desktop/tests/e2e/run.ts` starts `services/relay` with `SKIP_AUTH=true`, and the cloud task sync WebSocket helper authenticates with bypass test tokens. That setup is useful for exercising desktop cloud task sync, relay routing, `kanna-server` command forwarding, daemon terminal observation, and UI state without Firebase Admin credentials, but it intentionally skips the non-bypassed relay auth branch that reads Firestore `desktopCredentials`.

To make this path end-to-end testable, the harness needs a non-bypassed relay mode wired to Firebase emulators through Admin SDK credentials or equivalent emulator-safe Firebase services. The desktop E2E would then need to:

1. Sign in the desktop app against the Auth emulator.
2. Wait for the desktop publisher to write `desktopCredentials/{desktopId}`.
3. Start or reconnect `kanna-server` with the saved `desktop_id` and `desktop_secret`.
4. Authenticate through the relay with `SKIP_AUTH=false`.
5. Observe a terminal session through the authenticated relay path.

Narrower coverage added instead:

- `services/relay/test/auth.test.ts` mocks Firebase services and verifies non-bypassed `desktopCredentials` auth success, wrong secret rejection, revoked rejection, missing `uid` rejection, and legacy `users/*/desktops` collection-group fallback.
- `crates/daemon/tests/reconnect.rs::test_concurrent_attach_snapshot_cutover_keeps_snapshot_first_and_streaming_live_output` exercises real daemon `AttachSnapshot` cutover behavior while PTY output is active, proving Snapshot arrives before live output and streaming continues across concurrent attaches.

The Firestore rules emulator test for `desktopCredentials` remains the rules-level proof for client denial/server bypass semantics, but it is not a substitute for the relay auth test because rules tests do not execute `services/relay/src/auth.ts`.
