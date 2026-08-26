# Task d19cb7fd: push-equivalent task event watch

## Goal

Give manager agents a supported long-lived `kanna-cli task watch` process that holds the task-event long poll open, owns cursor advancement, and lets the agent harness wake the manager when the process exits.

## Scope and constraints

- Support repeatable task/repository scopes, live-tail startup by default, explicit cursor resume, actionable-event filtering by default, `--all`, quiet budgets, and continuous `--follow` streaming.
- Reuse the shared event-feed wait implementation and its per-call timeout clamp. Keep MCP `kanna_wait_events` clamped to the client-safe budget; document that arbitrarily long watches belong to the CLI because MCP clients can abort around 300 seconds and lose the result. Do not add server-initiated PTY injection or reimplement event-time state (task 483f3563 owns that feed correction).
- Update CLI help/guide and the task-manager agent definition to prescribe a background `task watch` / wake / drain / re-arm cycle while continuing to discourage hand-written raw-wait wrappers. Coordinate with the definition work from task dafe907a rather than reverting it.
- Add CLI/contract coverage for no-replay tail startup, cursor progress across loop iterations, filtering, actionable and follow exit modes, and quiet-budget expiry. Add client/server E2E coverage or a dated gap note.

## Done when

The command and documentation expose the contract above, focused Rust and CLI-contract tests pass, and the implementation consumes event-time feed state without duplicating task 483f3563's work. The missing process/harness client-server E2E is recorded in `docs/2026-08-26-task-watch-client-server-e2e-gap.md` with the narrower coverage landed here.

## Operational evidence

The task manager's hand-rolled long watch produced roughly one wake every 48 minutes instead of one manager turn per 240-second MCP wait: about a 12x reduction in wasted manager turns. This command makes that UX a supported contract.

## Directive provenance

- Owner directive, 2026-08-26: “go ahead and improve the agent ux, i'd like to have essentially push notifications for the task manager. I think the only way to achieve that is through, long event waits.”
