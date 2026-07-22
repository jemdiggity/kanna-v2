# QA Dispatch Review

Dispatched specialty reviews for the review stage: a QA dispatcher agent
decides at review time which specialty reviews a branch needs (UI, security,
network/runtime performance, plus repo-defined specialties), fans each one out
as a child review task over a fork of the same branch, and aggregates the
verdicts into the single review decision the pipeline already understands.

This is the "review manager" workflow anticipated by
[task-graph-stages](task-graph-stages.md): the engine executes structure known
in advance (the linear stage rail); agents create structure discovered at
runtime. The dispatcher is an agent composing existing primitives — no new
stage-engine semantics were added.

## Design

### No engine changes

Pipelines stay linear. Parallelism lives in child-task fan-out
(`kanna_create_task` with `base_ref` = the dispatcher's branch,
`parent_task_id`/`notify_task_id` = the dispatcher's task), and join is the
dispatcher's job (`kanna_wait_task`, then reading the child's recorded
verdict). This follows the task-graph spec's fan-out/join section: join
semantics are deliberately not engine-enforced.

### Built-in definitions

- **`qa-dispatch` pipeline** — the standard
  `in progress` (post: `commit`) → `review` → `pr` (post: `approve`) rail,
  with the review stage bound to the `qa-dispatcher` agent
  (`transition: auto`).
- **`specialty-review` pipeline** — a single manual `review` stage with **no
  agent binding**; the dispatcher binds the specialty agent through the
  create request's `agent` override. Manual is the uniform choice: the
  engine only auto-advances on `success`, so an auto stage would close PASS
  children while FAIL children parked — two lifecycles for one kind of
  child, and dispatcher logic that branches on outcome. With manual, both
  verdicts park the child unread (which `kanna_wait_task`
  `until: "finished"` observes) and the dispatcher owns the whole child
  lifecycle: it created every child, and it closes every child after
  collecting its verdict.
- **`qa-dispatcher` agent** — characterizes the diff, selects specialties,
  creates the children, joins, and records the aggregate verdict:
  all PASS → `kanna_complete_stage success` (auto-advances to `pr`); any
  FAIL → `kanna_request_revision` to `in progress` with the merged findings.
  If no specialty applies it reviews the branch itself against the ordinary
  coverage expectations.
- **Specialty reviewer agents** — read-only reviewers with a shared verdict
  contract: `kanna_complete_stage` `success`/`failure` with a
  `PASS:`/`FAIL:` summary. They never call `kanna_request_revision`; the
  dispatcher owns the aggregate decision. Built-in roster (universal
  dimensions only, with deliberately disjoint scopes so findings do not
  duplicate):
  - `review-ui` — user-visible behavior and its E2E/interaction coverage
    (includes i18n and accessibility; not separate agents, since they would
    overlap `review-ui` on nearly every dispatch)
  - `review-security` — untrusted input, secrets, privilege and boundary
    changes
  - `review-perf` — network and runtime performance of changed paths
  - `review-concurrency` — races, async coordination, lifecycle/cancellation,
    retry/reconnect (the "concurrency review" the task-graph spec named)
  - `review-migration` — data at rest written by older versions: schema
    migrations, stored formats, snapshots
  - `review-compat` — cross-process contracts: wire protocols, APIs,
    serialized messages, version negotiation (migration owns at-rest data;
    compat owns between-process data)

  Repos add their own specialties by creating
  `.kanna/agents/review-*/AGENT.md`; the dispatcher discovers them from the
  worktree. The Kanna repo itself carries `review-release` this way — a
  repo-local reviewer for its packaging invariants (vendoring, compiled
  builtin registration, build-private sidecar paths, OTA runtimeVersion,
  versioning through kd) — which is deliberately absent from
  `compiled_builtin_resource` so it never ships as a built-in.

Specialty reviewers are top-level agent roles rather than `review@<flavor>`
flavors: a repo override of `.kanna/agents/review/AGENT.md` shadows every
`review@…` selector (flavor resolution only consults builtin resources), so
flavors would silently disable specialty dispatch in any repo that customizes
the generic review agent — including this one.

### Server surface changes

Two gaps stood between the dispatcher and the existing primitives:

1. **`agent` override on `kanna_create_task`.** The HTTP API already accepted
   `CreateTaskRequest.agent` (it overrides the pinned pipeline stage's agent
   binding); the shared tool catalog now exposes it to MCP/CLI callers, and
   `kanna-cli task create` grew a matching `--agent` flag. The `stage`
   override remains deliberately unexposed.
2. **`latestRun` on `TaskDetail`.** The task-graph spec promises a child's
   terminal `stage_run.result` is queryable via `kanna_get_task` /
   `kanna_wait_task`; the detail payload now carries
   `latestRun {stage, kind, status, summary, finishedAt}` populated from the
   task's most recent stage run. Verdict summaries are parsed out of the run's
   result JSON; non-verdict results (e.g. orphaned-workspace markers) pass
   through as-is.

## Verdict flow

```
parent review stage (qa-dispatcher, auto)
  ├─ kanna_create_task {pipeline_name: specialty-review, agent: review-ui,   base_ref: $BRANCH, parent/notify: self}
  ├─ kanna_create_task {pipeline_name: specialty-review, agent: review-sec…, base_ref: $BRANCH, parent/notify: self}
  ├─ kanna_wait_task until finished (per child; notify "TASK <id> DONE" doubles as a wake-up)
  ├─ kanna_get_task → latestRun.status/summary   (succeeded=PASS / failed=FAIL)
  ├─ kanna_close_task (every child, after collecting its verdict)
  └─ all PASS → kanna_complete_stage success → auto-advance to pr
     any FAIL → kanna_request_revision "in progress" with merged findings
```

## Test coverage

- `crates/kanna-tool-catalog/tests/catalog.rs` — the `agent` param is exposed
  and maps into the create body; `stage` remains rejected.
- `crates/kanna-cli` — typed `task create --agent` surface matches the
  catalog; request body serialization includes `agent`.
- `crates/kanna-server` `task_creator::tests::core` — the builtin
  `qa-dispatch`/`specialty-review` pipelines and all four dispatch agents
  resolve from compiled resources; a dispatcher-style create request
  (`specialty-review` + `agent: review-security` + parent/notify) prepares a
  spawn bound to the specialty agent with a manual completion transition.
- `crates/kanna-server` `mobile_api` — `get_task` surfaces the latest stage
  run verdict (and omits `latestRun` for tasks without runs).
- `packages/core` `qa-assets.test.ts` — the new agents satisfy the built-in
  agent completion-protocol contract (MCP-first with CLI fallback).

### E2E gap

The full dispatch loop (dispatcher session creating children, children
recording verdicts, dispatcher aggregating and advancing) is driven by live
agent behavior across daemon PTY sessions, so it is not yet covered end to
end: the packaged-app WebDriver harness cannot deterministically drive
multi-agent completion without external agent CLI credentials, and the fake
daemon used by the server-boundary notify tests does not execute agent
prompts. What would make it testable is a scripted agent provider (or
OpenCode free-model live harness, per `pnpm test:agent-cli-compat`
conventions) that can follow the dispatcher/specialty prompts
deterministically. Until then, the wiring is proven piecewise by the
server-boundary tests above: every tool call the dispatcher makes
(create-with-agent, wait, get-latest-run, close, complete/revise) has direct
coverage against the real server and DB.
