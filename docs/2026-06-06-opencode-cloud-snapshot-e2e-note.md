# OpenCode cloud snapshot E2E coverage note

OpenCode task snapshot publishing crosses the desktop-to-Firebase Functions boundary: desktop builds a `CloudTaskSnapshot` from `PipelineItem.agent_provider`, publishes it to the task snapshot function, and the function validates `agent.provider` before writing.

A Firebase emulator E2E for this branch is not currently practical as a focused regression because the existing desktop cloud E2E harness starts the broader desktop app, Firebase emulator suite, relay, `kanna-server`, daemon terminal path, and DB/sidebar state. Exercising only this provider contract through that path would require a stable seeded OpenCode task fixture and emulator orchestration for the task snapshot function in the worktree; that fixture is not available as a narrow test target yet.

To make this end-to-end testable, add a reusable emulator-backed desktop cloud snapshot publish fixture that can seed a local `PipelineItem` with each supported agent provider, invoke the real desktop publisher against the local Functions emulator, and assert the written Firestore snapshot.

Narrower coverage added instead:

- `services/firebase-functions/test/taskSnapshots.test.ts` verifies `validateTaskSnapshotInput` accepts `agent.provider = "opencode"`.
- `apps/desktop/src/utils/cloudTaskSnapshot.test.ts` verifies an OpenCode `PipelineItem.agent_provider` maps to `snapshot.agent.provider = "opencode"`.
- `apps/desktop/src/services/desktopCloudPublisher.test.ts` verifies the desktop publisher sends `agent.provider = "opencode"` to the cloud task publisher.
