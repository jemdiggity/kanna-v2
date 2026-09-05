# MCP post completion: live-agent E2E verification gap

Task: `756c4972` (2026-09-05).

The real desktop test `apps/desktop/tests/e2e/real/stage-continue-agent-submit.test.ts`
now asks the commit post to call `kanna_complete_stage` through its existing MCP
connection, and requires a succeeded post plus transition to `holding`. Previously
it used CLI completion and allowed the task to remain in `in progress`.

The test was run with the repository harness:

```
pnpm --dir apps/desktop test:e2e real/stage-continue-agent-submit.test.ts
```

The isolated desktop, server, and daemon started successfully. The live-agent
case timed out waiting for `continue-stage-real-submit.txt` after 180 seconds,
before it could exercise the completion call or transition assertion. The
harness output does not establish why the agent failed to perform that first
instruction. This is not evidence that MCP completion succeeded. The harness
stopped the instance and removed its fixture resources.

To close this gap, rerun the test with a functioning unattended agent session
(the harness defaults to OpenCode `opencode/big-pickle`), verify it executes the
post's marker instruction, and require the existing MCP completion and `holding`
assertions to pass. Do not restore a CLI fallback or weaken the transition check.

Narrower executable coverage passed:

- Server HTTP route: omit `runId` for a bound running commit post, finish that
  post, and execute the deferred engine transition through the daemon fixture.
- Server HTTP routes: reject stale main ids and ambiguous omitted ids with both
  candidate ids, preserving running state; explicit completion disambiguates.
- Revision route: a sole bound review run resolves without an id, and a crossed
  task/run pair remains rejected.
- Real MCP stdio adapter process: retain the original main identity on a lost
  response retry, then read the updated server-owned context and complete a new
  post without restarting, despite the original run id remaining in its env.
