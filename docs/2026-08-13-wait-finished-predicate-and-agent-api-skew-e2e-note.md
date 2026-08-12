# `kanna_wait_task` finished-predicate defect and agent-API version skew

Found on 2026-08-13 while running the `specialized-reviewers` review stage of
task `c253bae2`. Two separate problems surfaced together, and only one of them
was a code defect.

## 1. The defect: `Finished` was decided by `activity`, not by the run

`kanna_wait_task(until: "finished")` resolved on
`pipeline_item.activity == 'unread'` and nothing else. An agent that finishes
and settles to `idle` never passes through `unread`, so a wait on such a task
burned its entire window and reported a timeout for a task that had carried a
terminal `stage_run` for minutes. A caller looping on that predicate — which is
exactly what the tool's own description tells it to do — waits forever, and
cannot tell "still working" from "finished".

Evidence from the session: child `de752098` recorded a terminal `failed` run at
22:01:48Z. Two successive waits, one started at 22:00:41Z with a 600s window
that spanned the moment the run finished, both returned "timed out waiting for
task de752098". `kanna_get_task` reported its activity as `idle`. The four
sibling children that settled to `unread` all resolved normally.

The fix makes the terminal `stage_run` — a database fact written when the run
recorded its verdict — the authority, with `activity` only a secondary signal.
`idle` on its own deliberately still does not resolve: a task that has not
started its first run is also `idle`, and resolving on that would report a task
as finished before its agent ever ran. The terminal run is what separates the
two, which is why the fix is the run rather than a wider set of activity values.
`cancelled` is not terminal — it is the transient state a rerun, resume, or
close passes through on the way to a replacement run.

The predicate existed in **three** hand-written copies (`kanna-mcp`, the typed
`kanna-cli` wait, the catalog-driven `kanna-cli` wait), which is how it drifted;
`kanna-mcp` even contradicted itself, since its own `activity_looks_stopped`
already counted `idle` as stopped. All three now share one implementation in
`kanna-tool-catalog`.

E2E coverage: `crates/kanna-mcp/tests/wait_finished_predicate.rs`, which drives
a real `kanna-server` (real SQLite, real HTTP) and a real `kanna-mcp` (real
stdio JSON-RPC), covering both the `idle` and `unread` settling paths plus the
never-started and still-running cases that must *not* resolve. Verified to fail
against the old predicate before the fix was applied.

## 2. Not a defect: the missing tools were pure version skew

The tools the dispatcher's instructions mandate are all present and wired on
`main` — catalog entry, server route, MCP exposure, and typed CLI subcommand:

| Surface | Location on `main` |
|---|---|
| `kanna_list_task_children` catalog entry | `crates/kanna-tool-catalog/src/catalog.json` |
| `GET /v1/tasks/{task_id}/children` route | `crates/kanna-server/src/http_api/router.rs` |
| `kanna-cli task children` | `crates/kanna-cli/src/main.rs` |
| `revisionRounds` / `revisionLimit` / `childTaskIds` | `crates/kanna-server/src/mobile_api.rs` |

Nothing was missing. The session was talking to `Kanna Staging.app`
(`0.1.0-staging.8`, port 48121), whose `release/0.1` branch is 672 commits
behind `main`. The two commits that introduced these surfaces landed on `main`
on 2026-07-29 and 2026-08-06 and were never on that branch. Confirmed live:
`GET /v1/tasks/{id}/children` on the running server returned **404 with a
zero-byte body**, and its `/v1/status` carried none of the newer fields.

This is the `running-app-lags-main` pattern. The bug worth fixing is not the
absent tool but the absence of any way for an agent to *detect* the absence.

## 3. The skew guard

`/v1/status` now advertises `agentApiTools`, the tool names the server's own
build can serve. `kanna_info` diffs that against the client's catalog and
reports an `agentApi` block: `current`, `server_behind` (naming the exact
unavailable tools), or `unknown`. A server too old to advertise the field at
all reports `unknown`, which is itself the signal — no version numbering to
maintain, and the comparison is exact rather than inferred.

Separately, `kanna-mcp` now reports a route-level 404 (404 with an empty body,
which is axum's "no such route" as opposed to the server's "no such task", which
always carries a message) as an explicit skew error rather than a bare status
code, and `.kanna/agents/qa-dispatcher/AGENT.md` gained the instruction for the
case where the children query does not exist at all. It already handled
version-*incomplete* records; it had nothing for the tool being absent, which
was the failure mode actually hit.

## 4. The delivery lag is not a server-side hold

The original report suspected the server held results past its own deadline.
It does not. The running build's wait loop bounds its own overshoot at one poll
interval (3s), so it cannot account for the observed ~2m21s. Reading that build
also corrected two premises: it applies **no clamp at all** to `timeout_secs`
(the catalog's `maximum: 600` is a schema hint only, so 90 was honoured as 90),
and it returns a hard `Err("timed out waiting for task …")` rather than the
`waitOutcome: "timeout"` plus latest detail that `main` returns. Both were
already fixed on `main` by `MAX_WAIT_TIMEOUT_SECS = 240` and the
`wait_timeout_result` path.

## What is not covered end to end, and why

The residual multi-minute gap between a tool call's completion and its delivery
to the agent is **not** covered by any test here, and its cause is not
established. It sits in the MCP client's own scheduling — including the
client-side backgrounding visible in the session transcript — which is outside
this repository. Nothing in `kanna-server` or `kanna-mcp` was found that
withholds a result past its deadline, and the wait loop's arithmetic rules out a
server-side explanation, but that is an exclusion rather than a diagnosis.

Making it testable would need a harness that timestamps at the agent's own
receive point rather than at the MCP process boundary, which is where the
measurement would have to come from to distinguish transport from client
scheduling. Until then, treat wall-clock latency between a run finishing and an
orchestrator acting on it as unattributed.
