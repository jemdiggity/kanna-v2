# Context-less completion retry E2E gap

Task `3f273d8f`, 2026-09-05.

The parent task's live-agent verification gap remains documented in
[the MCP post completion note](2026-09-05-mcp-post-completion-e2e-gap.md).
The desktop harness does not currently provide a deterministic way to drop a
completion response after the server accepts it and force the live agent to
reissue exactly that request after transition. Closing this gap needs that
transport fault-injection control plus a functioning unattended agent session.

Narrower coverage exercises the real server route, SQLite, git/worktree stage
transition and a daemon protocol fixture: complete a context-less post, wait
for the next main run, recreate the router, retry the same key, compare the
original acknowledgement and verify the successor remains running without a
result. A changed verdict with the same key conflicts. Real MCP stdio and CLI
subprocess tests verify stable keys without any completion context; both CLI
paths retry after a deliberately dropped HTTP response. A DB test verifies
that a rejected duplicate binding rolls back both the run and its event.
