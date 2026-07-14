# OpenCode cloud snapshot E2E coverage note

OpenCode task snapshot publishing crosses the SQLite, singleton `kanna-server`, authenticated relay, Firebase Admin, and Firestore mobile-index boundaries. Renderer windows do not publish task documents.

A Firebase emulator E2E for this branch is not currently practical as a focused regression because the existing desktop cloud E2E harness starts the broader desktop app, Firebase emulator suite, relay, `kanna-server`, daemon terminal path, and DB/sidebar state. Exercising only this provider contract through that path would require a stable seeded OpenCode task fixture and authenticated Firestore emulator orchestration in the worktree; that fixture is not available as a narrow test target yet.

The reusable focused path is now `pnpm --dir apps/desktop test:e2e:cloud-mobile-index`. A provider matrix can extend that fixture by seeding each provider and asserting the value returned by the mobile task index.

Narrower coverage added instead:

- `crates/kanna-server/src/cloud_task_publisher.rs` tests provider mapping in the server-owned snapshot.
- Relay tests verify validated Firebase Admin reconciliation under the authenticated desktop subtree.
- `apps/desktop/tests/e2e/real/cloud-prod-smoke.test.ts` verifies authenticated clients cannot write desktop or task publication documents.
