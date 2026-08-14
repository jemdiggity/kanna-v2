# Agent Flavor Resolution E2E Gap

Agent flavor resolution crosses workflow stage JSON, `.kanna/config.json`,
repo-local agent overrides/extensions, Tauri bundled resources, `kanna-server`
task creation, and frontend workflow preview loading. A full workflow-with-flavor
E2E is not currently practical as a focused automated regression because the
desktop E2E harness does not provide a deterministic fixture that creates a
real flavored workflow stage, launches the matching task workspace, captures the
spawned agent prompt, and asserts which bundled or repo-local `AGENT.md` body
was used without invoking a live agent CLI.

What would make this testable end to end:

- a committed fixture repository with `.kanna/workflows/*.json`,
  `.kanna/config.json` `flavors`/`vars`, and repo-local `.kanna/agents/<role>`
  overrides/extensions
- a harness hook that creates a task through the real desktop flow and exposes
  the resolved agent definition or final spawned prompt before the external
  agent CLI starts
- stable assertions for Tauri bundled resource fallback in the same mode used
  by packaged builds

Narrower regression coverage added instead:

- `crates/kanna-server/src/task_creator/tests/core.rs` verifies server-side
  flavor resolution order, role-level `EXTEND.md` layering on explicit built-in
  flavors, and repo-config AGENT.md variable substitution with runtime variables
  reserved.
- `apps/desktop/src/stores/workflowAgentExtension.test.ts` verifies the
  frontend loader mirrors server-side flavor resolution, extension layering, and
  runtime variable reservation.
- `tests/cli-contract/tests/offline/agent-flavor-contracts.test.ts` verifies each
  shipped flavor parses, renders, and only references tools present in
  `crates/kanna-tool-catalog`.
- `packages/core/src/config/repo-config.test.ts` verifies `.kanna/config.json`
  parses `flavors` and AGENT.md `vars`.
