# QA specialty verdict history: end-to-end coverage gap

2026-08-06. Written alongside the durable direct-child history surface
(`GET /v1/tasks/{task_id}/children`, `kanna_list_task_children`, and
`kanna-cli task children`).

## Behavior that needs end-to-end proof

The complete workflow spans several independently scheduled processes and more
than one review round:

1. A live QA dispatcher agent session creates several `specialty-review` child
   tasks in parallel.
2. Each child runs its specialty agent in a separate PTY/task session and
   records a terminal PASS or FAIL verdict.
3. The dispatcher waits for the children, reads their verdicts, and closes
   them.
4. A later fresh dispatcher session queries the same parent's direct children,
   includes the closed children, reduces the chronological history to the
   latest verdict per specialty, and carries untouched verdicts into its new
   aggregate decision.

That full chain is the risk boundary: it proves that parentage, independent
agent execution, recorded stage runs, child closure, and cross-round recovery
compose correctly rather than merely working in isolation.

## Why current CI cannot drive it deterministically

The dispatcher and specialty reviewers are prompt-driven live agents. Running
the full workflow today requires external agent CLIs and credentials, real PTY
sessions, concurrent child scheduling, and deterministic compliance with tool
calls across several task sessions and fresh review rounds. CI cannot control
the timing or output of those external models closely enough to assert a stable
multi-round verdict history. The fake daemon used by narrower server tests does
not execute agent prompts, so it cannot stand in for this behavior.

## What would make it testable

A deterministic scripted or fake agent execution provider must be able to run
inside normal Kanna task sessions and PTYs, follow configured tool calls, emit
chosen PASS/FAIL stage results, and participate across parent/child sessions and
multiple fresh review rounds. With that provider, an E2E test could script the
first panel, close its children, start a later dispatcher, and assert the exact
new-versus-carried aggregate without external credentials or model variance.

## Narrower coverage added meanwhile

- The real Axum router plus SQLite test
  `list_task_children_route_returns_open_and_closed_direct_children_with_verdicts`
  covers direct-only ordering, closed and runless children, unrelated tasks,
  exclusion of grandchildren, latest-run verdict data, and the
  `pipelineName` discriminator.
- Tool-catalog tests cover the MCP tool's path mapping and input schema;
  typed CLI tests cover `task children --task-id`, API path construction, and
  request/response serialization of the child and latest-run shapes.
- `packages/core/src/pipeline/qa-assets.test.ts` pins the shipped dispatcher
  prompt contract: MCP-first lookup, pipeline discrimination, fail-closed
  malformed/version-incomplete records, finite repair behavior, chronological
  verdict reduction, and carried-failure handling.
- Existing server tests cover the individual wait/get/close operations and
  terminal run-result retrieval used by the dispatcher after creating a child.

**No actual end-to-end test was added.** These tests prove the storage, HTTP,
tooling, and shipped-prompt pieces separately; they do not execute the full
live dispatcher → parallel children → close → fresh-round carry-forward chain.
