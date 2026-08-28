# Review verdict run binding — E2E gap (2026-08-27)

Agent `request_revision` verdicts are now fenced by the immutable review
`stage_run` id carried in the spawned process's completion context. Server
integration coverage drives two real HTTP revision conclusions concurrently,
proves both task/run pairs land independently, and proves a crossed pair is
refused without closing either review or spending a round.

A real E2E is not currently practical because it requires two provider PTY
reviewers to finish at the same instant while deterministically overriding one
adapter's private spawn-context run id. The ordinary CLI/MCP schema correctly
does not expose that id as an agent-authored parameter. An injectable
provider-process harness that can pause both verdict calls after adapter
binding would make this boundary deterministic; until then, the router + DB +
workspace preparation + fake-daemon integration test covers the server wiring
without weakening the production interface.
