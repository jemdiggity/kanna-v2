# OpenCode cloud snapshot E2E coverage note

OpenCode task snapshot publishing crosses the desktop auth and direct Firestore boundary: desktop builds a `CloudTaskSnapshot` from `PipelineItem.agent_provider`, resolves the signed-in user's desktop document, and writes the task under `users/{uid}/desktops/{desktopDocId}/tasks/{taskDocId}`.

A Firebase emulator E2E for this branch is not currently practical as a focused regression because the existing desktop cloud E2E harness starts the broader desktop app, Firebase emulator suite, relay, `kanna-server`, daemon terminal path, and DB/sidebar state. Exercising only this provider contract through that path would require a stable seeded OpenCode task fixture and authenticated Firestore emulator orchestration in the worktree; that fixture is not available as a narrow test target yet.

To make this end-to-end testable, add a reusable emulator-backed desktop cloud snapshot publish fixture that can seed a local `PipelineItem` with each supported agent provider, invoke the real desktop direct Firestore publisher against authenticated emulator state, and assert the written nested Firestore snapshot.

Narrower coverage added instead:

- `apps/desktop/src/utils/cloudTaskSnapshot.test.ts` verifies an OpenCode `PipelineItem.agent_provider` maps to `snapshot.agent.provider = "opencode"`.
- `apps/desktop/src/services/desktopCloudPublisher.test.ts` verifies the direct Firestore publisher writes `agent.provider = "opencode"` into the nested desktop task document.
- `apps/desktop/tests/e2e/real/cloud-prod-smoke.test.ts` verifies authenticated staging/production users can create, update, read, and clean up nested desktop task documents while flat `users/{uid}/tasks` writes stay denied.
