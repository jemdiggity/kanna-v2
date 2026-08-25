# Relayed revision authorization E2E gap (2026-08-25)

The attributed `kanna_request_revision` path crosses the shared tool catalog,
kanna-mcp/kanna-cli request mapping, HTTP server, SQLite stage-run/event
persistence, daemon-backed revision transition, and task-detail read surface.
The repository does not yet have a real-E2E driver for `request_revision`; the
existing limitation and prerequisites are described in
`docs/2026-08-21-revision-fork-lineage-e2e-gap.md`.

This change therefore covers the boundary with narrower executable tests:

- shared catalog request resolution verifies the CLI-shaped argument becomes
  the attributed server body;
- the MCP stdio/HTTP fixture verifies the same mapping through MCP;
- the server router test sends two serialized HTTP actions: an exhausted agent
  request that finishes and parks the review run, followed by a daemon-backed
  attributed human relay. After the revision lands it reopens SQLite and
  verifies the preserved parked verdict/metadata/feedback, both revision
  events, the added stage-run attribution, the reset count, and public
  task-detail attribution;
- the exhausted agent-origin router test proves the budget refusal and
  no-retry guidance remain intact.

Close this gap when the real-E2E harness can create and park a review-stage
task with a pinned revision limit, invoke catalog tools against the live
server, and observe the replacement PTY session. The scenario should exhaust
the agent budget, relay an attributed human authorization through both shipped
clients, restart the server to prove persistence, and read the attribution
from task detail afterward.
