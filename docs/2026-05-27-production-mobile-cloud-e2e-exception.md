# Production Mobile Cloud E2E Exception

The production mobile/cloud defaults cross these boundaries:

- mobile app config and signed-in cloud task index selection
- Firebase Auth and task snapshot storage
- Cloud Run task snapshot function endpoint
- relay routing to the desktop `kanna-server`
- task-transfer, daemon terminal streaming, and local DB state

True production E2E is not feasible in the current local and CI harness because it would require stable production Firebase users, production Firestore writes, the deployed Cloud Run task snapshot function, the deployed relay, and at least one signed desktop instance reachable through the production relay. Running that path from CI would mutate production user task state and would depend on external service availability, credentials, and cleanup guarantees that the current harness does not provide.

What would make true production E2E testable:

- a dedicated production-like Firebase project or isolated tenant seeded only for E2E
- short-lived test credentials provisioned by CI
- a disposable signed desktop build registered as an online relay endpoint
- task snapshot and relay cleanup APIs scoped to the test tenant
- mobile physical-device or simulator runs configured to use that isolated environment

Current narrower coverage:

- `pnpm --dir apps/mobile test -- --runInBand App lib/firebase/config` verifies the mobile production relay default and signed-in cloud task-index selection without requiring production services.
- `pnpm --dir apps/desktop test` verifies the desktop production Firebase app config, production task snapshot function endpoint, and sidecar packaging contract.
- `cargo test -p kanna-runtime-defaults -p kanna-task-transfer defaults -- --test-threads=1` verifies shared runtime sidecar path defaults used by desktop, `kanna-server`, and task-transfer.
- `pnpm --dir apps/desktop exec tsx tests/e2e/run.ts real/cloud-task-sync.test.ts` exercises the end-to-end desktop cloud task snapshot flow through Firebase emulators, a local relay, `kanna-server`, daemon terminal output, terminal input, and DB/sidebar state without touching production services.
