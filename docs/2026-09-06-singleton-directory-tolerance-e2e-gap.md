# Legacy singleton-directory tolerance: cross-boundary E2E is written but cannot run

**Date:** 2026-09-06
**Change:** per-machine, per-repository legibility in the account-wide singleton
directory (`services/relay/src/cloudTaskPublication.ts`), replacing a global
refusal that disabled every singleton lookup and claim on an account whenever
any one desktop had not published `singletonDirectoryVersion: 1`.

## Why a note exists

The behaviour crosses the phone → desktop → relay → Firestore boundary, so the
repo's E2E expectation applies. The cross-boundary cases are written, in
`tests/remote-e2e/src/task-listing-actions.e2e.test.ts` ("launches, reuses, and
honestly refuses a repository singleton command over the LAN route"):

- a stranded desktop with `singletonDirectoryVersion: 0` that published an
  **open task for the target repository** — the real hazard — still refuses the
  launch, names that machine, and creates nothing;
- the same desktop holding an open task for a **different** repository only —
  the launch succeeds and creates exactly one manager;
- a second launch reuses it and reports the owner machine and the owner's own
  repository id;
- a stale catalog revision is refused separately and creates nothing.

They have not been executed, here or anywhere.

## The blocker

`./kd test remote-e2e --dev` cannot reach its first test. `waitForHttpOk` in
`tests/remote-e2e/src/processes.ts` polls `/v1/status` with `fetch`, and Node
v24.15.0's undici attaches `sec-fetch-mode: cors` to every request.
`crates/kanna-server/src/http_api/lan_trust.rs:27-30,159` treats any
`Sec-Fetch-*` header as browser-originated, so the request is refused 403
("browser requests must present this desktop's local control credential") and
the harness times out in `startRemoteHarness` before a single test runs.

Reproduce the header in one line:

```
node -e 'const http=require("http");const s=http.createServer((q,r)=>{console.log(q.headers);r.end("{}");s.close()});s.listen(0,()=>fetch("http://127.0.0.1:"+s.address().port))'
```

This is pre-existing and lane-wide — every remote-e2e test reaches the LAN API
through `fetch` — and is unrelated to this change. The lane is local-only; no
workflow under `.github/workflows` runs it.

## What ran instead

`services/relay/test/integration.test.ts` against a real relay socket and the
Firestore emulator, which is the wiring this change actually lives in. 348
tests pass. Specifically:

- "scopes an unreadable legacy directory to the repositories it cannot answer
  for" — a known owner is still returned while a legacy peer is present; a
  claim acquires exactly once where nothing is owned; a legacy machine holding
  an open task for the repository refuses creation with the typed
  `RepoSingletonDirectoryIncomplete` and writes no reservation; an open task
  with no repository hash is unattributable and refuses the same way; one
  repository's uncertainty leaves another's lookup and claim untouched; a
  stored claim naming a legacy machine is preserved while its index still shows
  an open task there and released only once that index disproves it; a
  version-1 offline owner is never released.
- "answers account-directory invokes that name no desktop, and never routes
  them" — the socket-level wire shape, including `illegible` beside `owners`.
- "atomically elects one owner for a %s singleton record" — extended with an
  `illegible-excluded-peer` variant: concurrent claims still elect exactly one.
- "keeps a paused creator exclusive across reconnect and recovers after
  restart" — extended with a legacy peer present: a live creator fence is still
  not released by the tolerance path.
- `services/relay/test/cloudTaskPublication.test.ts` — the legibility rule in
  isolation, including a task row with no `closedAt` field treated as open.

## What would close this

Either pin the remote-e2e lane to a Node release whose `fetch` sends no
`Sec-Fetch-*` headers, or route the harness's LAN calls through `node:http` or
the desktop's local control credential (`KANNA_TASK_EVENTS_TOKEN_PATH`) so they
are classified as local-process requests. That is a separate defect affecting
every remote-e2e test and deserves its own work item; it is deliberately not
fixed here.
