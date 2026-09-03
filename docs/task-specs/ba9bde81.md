# Account-wide repository singletons

Goal: make singleton agents such as `task-manager` and `merge` unique per agent and repository remote URL hash across all desktops reachable through the signed-in account.

Scope:
- Before creating, discover open matching singletons locally, in the relay-backed durable account directory, and on active sibling desktops; route the signal to the sole owner through the existing authenticated relay transport.
- For a remote-backed repository, atomically reserve account-wide ownership by remote URL hash plus agent before writing the local task. The reservation names the proposed task and requesting desktop, so simultaneous first signals have exactly one winner; a loser routes to the completed owner or fails closed while its creation is still in progress, without creating locally. Release a winning reservation if local preparation fails, and reconcile durable ownership from published open-task snapshots.
- If no matching singleton exists, create it on the machine handling the request.
- Refuse with an error naming the task and machine when its owner is unreachable, and refuse/log when duplicate open owners are found. Do not choose an owner or create an implicit replacement.
- Repositories without a remote URL hash retain per-machine singleton behavior.
- Cover sibling discovery and routing, unreachable-owner refusal, duplicate detection, and the no-remote fallback at the narrowest real cross-machine boundary available; document any remaining two-machine E2E harness gap.

Constraints:
- Preserve existing cross-machine authorization and routing boundaries; do not add account-wide placement for ordinary tasks or expose task transfer/takeover through the agent catalog.
- A future takeover must be an explicit named operation that reconciles the stranded singleton on reconnect; it is deliberately out of scope here.
- Owner directive, 2026-09-03: “there shouldn't be singletons per machine. it should be per repo across machines.”

Done when both singleton signal entry points enforce this resolution contract, the server boundary documents it, and focused Rust plus cross-machine wiring tests pass.

Revision directive, reviewer round 1 on 2026-09-03: replace distributed absence-check-then-create with an account-wide atomic claim spanning local creation and failure cleanup, and add a deterministic concurrent two-desktop first-signal integration test.
