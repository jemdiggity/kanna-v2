# Staging desktop server config E2E gap

The signed `Kanna Staging.app` startup path crosses Bazel/Tauri bundle identity,
Tauri app initialization, desktop `read_env_var` behavior, generated
`server.toml`, and the spawned `kanna-server` sidecar. A true regression E2E
would install or launch a signed non-debug `Kanna Staging.app` with no shell
cloud env, wait for the desktop-started server, then assert that
`~/Library/Application Support/build.kanna.staging/Kanna/server.toml` contains:

- `relay_url = "wss://relay-staging.kanna.build"`
- `firebase_project_id = "kanna-staging"`
- no Firebase emulator host settings

That E2E is not currently feasible in the regular local desktop harness because
`apps/desktop/tests/e2e/run.ts` launches a debug Tauri/Vite app from the
worktree, injects local relay/emulator environment for test isolation, and does
not install or drive a signed `Kanna Staging.app` bundle. The existing
full-bundle updater E2E path builds temporary debug bundles for updater behavior;
it does not exercise the staging release bundle identifier, production signing,
or the installed app's Application Support scope.

To make this testable end to end, the harness needs a release-mode installed app
fixture for `build.kanna.staging`, a way to run it with `KANNA_CLOUD_ENV`,
`KANNA_RELAY_URL`, `KANNA_RELAY_PORT`, and Firebase emulator env vars absent, and
a WebDriver or process-control hook that can wait for the desktop-started
`kanna-server` before inspecting the generated server config.

Narrower regression coverage carries this change for now:

- `apps/desktop/src-tauri/src/commands/mobile.rs` tests verify that release-mode
  `build.kanna.staging` bundle identity flows into `MobileServerManager` and
  produces staging relay/Firebase defaults while suppressing emulator config.
- `apps/desktop/src-tauri/src/commands/mobile.rs` tests verify production bundle
  defaults, explicit `KANNA_RELAY_URL`/`KANNA_RELAY_PORT` overrides, and
  `server_config_matches_runtime` rejection of stale cloud Firebase config.
- `crates/runtime-defaults/src/lib.rs` tests verify the shared bundle identifier
  to desktop cloud environment mapping and the relay/Firebase defaults used by
  both frontend env fallback and server config generation.
- `apps/desktop/src/ship.test.ts` and
  `apps/desktop/src/services/desktopRelayTerminal.test.ts` keep the staging
  desktop bundle identity and frontend staging cloud transport behavior covered.
