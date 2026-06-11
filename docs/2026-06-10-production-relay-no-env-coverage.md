# Production relay no-env coverage

The production cloud relay fallback crosses desktop and mobile runtime config, Firebase Auth, WebSocket relay routing, and remote terminal/task plumbing. True E2E coverage for the signed production no-env path is not currently feasible in the local desktop E2E harness because:

- `apps/desktop/tests/e2e/run.ts` launches debug Tauri/Vite builds, so `import.meta.env.DEV` is true for the desktop client.
- The same harness allocates and injects `KANNA_RELAY_PORT` for a local relay, so it does not exercise the absence of both `KANNA_RELAY_URL` and `KANNA_RELAY_PORT`.
- A real production terminal/task assertion would require a signed-in production or production-like Firebase user, a reachable desktop registered with the deployed relay, stable cloud task state, and cleanup for any task/desktop documents created during the run.

To make this end-to-end testable, the harness needs a release-mode app launch path that can run with both relay env vars absent, production-like Firebase credentials isolated to E2E, and a controlled relay peer/desktop fixture capable of serving remote terminal and task commands through the deployed or production-like relay.

Narrower coverage added in the meantime:

- `apps/desktop/src/services/desktopRelayTerminal.test.ts` verifies that `createConfiguredDesktopRelayTerminalClient()` and `listActiveDesktopIdsViaRelay()` read absent relay env vars in production mode, construct WebSockets against `wss://relay.kanna.build`, authenticate, and send the expected relay terminal/RPC commands instead of returning `null`.
- `apps/mobile/src/App.test.tsx` verifies the mobile production relay default and signed-in remote model behavior without falling back to loopback LAN.
- `apps/desktop/src-tauri/src/commands/mobile.rs` tests verify the desktop sidecar server config defaults to the production relay outside debug builds when relay env vars are absent.
