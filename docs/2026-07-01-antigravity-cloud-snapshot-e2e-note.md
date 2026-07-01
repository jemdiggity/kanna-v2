# Antigravity cloud snapshot E2E coverage note

Antigravity provider propagation crosses the local task model, cloud snapshot publisher, Firestore-backed cloud task index, and the remote task UI model. A full end-to-end regression would need to create a real Antigravity-backed task, publish its cloud snapshot, read it back through the cloud task index, and assert the remote task remains `agent_provider = "antigravity"`.

That flow is not currently practical as a focused automated E2E because this repo does not have a stable Antigravity CLI contract fixture or real-agent E2E harness. Existing real-agent provider coverage is centered on Codex and OpenCode, and the cloud task sync E2E uses seeded Codex tasks rather than a provider matrix. Running a true Antigravity task would also require the external `agy` CLI, account/auth state, and a deterministic prompt/session contract suitable for CI.

To make this feasible, add an Antigravity test fixture with the same properties as the OpenCode real-agent fixture: reliable installation or skip detection, a deterministic low-cost prompt, a known model/permission contract, and cloud task sync helpers that can run the same publish/read assertion for every supported provider.

Focused coverage added instead:

- `apps/desktop/src/utils/cloudTaskSnapshot.test.ts` verifies an Antigravity `PipelineItem.agent_provider` maps to `snapshot.agent.provider = "antigravity"`.
- `apps/desktop/src/services/desktopCloudPublisher.test.ts` verifies the direct Firestore publisher writes `agent.provider = "antigravity"` into the nested desktop task document.
- `apps/desktop/src/services/desktopCloudTaskIndex.test.ts` verifies a cloud task snapshot with `agent.provider = "antigravity"` maps back to a `PipelineItem` with `agent_provider = "antigravity"`.
