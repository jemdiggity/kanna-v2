# Production Mobile Cloud E2E Exception

The production mobile/cloud defaults cross these boundaries:

- mobile app config and signed-in cloud task index selection
- Firebase Auth and task snapshot storage
- relay-owned Firebase Admin reconciliation under `users/{uid}/desktops/{desktopDocId}/tasks/{taskDocId}`
- relay routing to the desktop `kanna-server`
- task-transfer, daemon terminal streaming, and local DB state

True full production mobile E2E is not feasible in the current local and CI harness because it would require stable production Firebase users, production Firestore writes, the deployed relay, and at least one signed desktop instance reachable through the production relay. Running that path from CI would mutate production user task state and would depend on external service availability, credentials, and cleanup guarantees that the current harness does not provide.

What would make true production E2E testable:

- a dedicated production-like Firebase project or isolated tenant seeded only for E2E
- short-lived test credentials provisioned by CI
- a disposable signed desktop build registered as an online relay endpoint
- task snapshot and relay cleanup APIs scoped to the test tenant
- mobile physical-device or simulator runs configured to use that isolated environment

Current narrower coverage:

- `pnpm --dir apps/mobile test -- --runInBand App lib/firebase/config mobileAppConfig e2e/helpers/env e2e/helpers/metro e2e/run e2e/specs/cloud/cloud-task-flow` verifies the mobile production relay default, per-environment config resolution, force-cloud transport selection over trusted LAN, and the cloud E2E harness wiring without requiring production services.
- `pnpm --dir apps/desktop test` verifies the desktop production Firebase app config and sidecar packaging contract.
- `cargo test -p kanna-runtime-defaults -p kanna-task-transfer defaults -- --test-threads=1` verifies shared runtime sidecar path defaults used by desktop, `kanna-server`, and task-transfer.
- `pnpm --dir apps/desktop exec tsx tests/e2e/run.ts real/cloud-task-sync.test.ts` exercises the end-to-end desktop cloud task snapshot flow through Firebase emulators, a local relay, `kanna-server`, daemon terminal output, terminal input, and DB/sidebar state without touching production services.
- `pnpm --dir apps/desktop test:e2e:cloud-mobile-index` is the focused single-instance boundary test for `kanna-server -> relay -> Firestore -> mobile task index`, including an activity transition to `working`.

Mobile cloud E2E harness added in this branch:

- `pnpm --dir apps/mobile run test:e2e:cloud` starts Metro with `EXPO_PUBLIC_KANNA_FORCE_CLOUD=1` and `KANNA_APP_ENV` propagated to `app.config.ts`.
- It requires `KANNA_E2E_CLOUD_EMAIL` and `KANNA_E2E_CLOUD_PASSWORD`, signs in through the mobile profile sheet, asserts the connection title is `Kanna Cloud`, then opens a task from the cloud task list.
- For local CI this should target `KANNA_APP_ENV=dev` with the Firebase emulator and local relay; staging/prod can use the same mode when test credentials and relay-visible task data are provided.

Remaining gap:

- CI does not yet provision a Firebase Auth user plus relay-visible cloud task snapshot for the mobile app. Until that seed/cleanup workflow exists, the cloud E2E mode is a runnable harness rather than a mandatory CI gate.
