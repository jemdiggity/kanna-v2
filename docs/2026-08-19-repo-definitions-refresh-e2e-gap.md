# Repo definitions: reads stay local, creation fetches

Date: 2026-08-19

## What changed

Repo-definition resolution was measured at 2.2–4.5 s per repo on a busy
machine, paid sequentially per repo on every coarse `StateChanged` — which put
seconds of Git work between an operator's keystroke and its echo. Three changes
moved that cost off the interaction path without weakening what task creation
resolves against.

1. **One pair of Git invocations per snapshot.**
   `RepoDefinitionSnapshot` (`crates/kanna-server/src/task_creator/definition_source.rs`)
   loads the whole `.kanna` subtree with `git ls-tree -r -t` plus a batched
   `git cat-file --batch`, instead of a tree lookup and a blob read per file.
   Reading this repo's 45 definition files went from ~16 `git` processes (1.39 s
   wall, 0.05 s CPU — almost entirely process-spawn latency under load) to
   0.06 s, and every read after the load is in memory.

2. **`origin` is fetched by the operations that commit to an answer, not by the
   ones that display it.** `OriginFreshness::Fetch` is the authoritative path:
   task creation, stage forks, reruns, and dormant starts keep resolving that
   way, because they pin a workflow onto a task or fork a workspace and must
   see the true remote tip. `OriginFreshness::Local` reads the remote-tracking
   refs already on disk, and is what the definitions cache — and therefore every
   read route — now uses.

3. **`POST /v1/repos/{repo_id}/fetch-origin`** fetches, drops the repo's cached
   definitions, and answers with what the repo now resolves to. The desktop's
   new-task modal calls it *beside* the open modal
   (`apps/desktop/src/composables/useAppTaskCreation.ts`): options render
   immediately from the refs on disk, then re-read once the fetch lands. Base
   branches come from the same refs via `git_list_base_branches`, so they
   refresh with the same round trip. The modal preserves any workflow or base
   branch the operator already picked, so a late refresh cannot move a choice
   out from under them.

`reloadSnapshot()` (`apps/desktop/src/stores/queries.ts`) also stopped
re-resolving definitions for every reload: it fills in repos the stage-order
cache has never seen, and re-reads them all only for a `repos`-scoped
`StateChanged`, a reconnect, or cold start.

## Why there is no E2E test

Two of the load-bearing assertions are negative ones about traffic: after a
task-activity change the desktop must not issue
`GET /v1/repos/{id}/kanna-definitions`, and that route must not run `git fetch`.
The mock E2E harness drives the app through WebDriver and asserts on rendered
DOM and DB rows; it has no request recorder for desktop→server calls and no way
to observe which Git commands the server ran, so neither is expressible today.

What would make them testable: a request-log endpoint or in-process counter on
`kanna-server` (definitions requests served, `git fetch` invocations) readable
from the existing `execDb`/`callVueMethod` helpers, so a test could snapshot the
counts, fire a task activity change or open the new-task modal, and assert on
what moved.

## What covers it meanwhile

- `crates/kanna-server/src/http_api/tests/repo_definitions.rs` — the full
  contract at the HTTP boundary against real Git fixtures: a workflow pushed to
  origin stays invisible to the manifest route even on a cold cache, and
  `fetch-origin` returns it and leaves the cache serving it.
- `crates/kanna-server/src/task_creator/definition_source.rs` tests — a local
  resolve reads the pre-push ref while origin is reachable (which is what proves
  no fetch ran), plus reads, listings, Git tree ordering including a name that
  collides with a directory, kind mismatches, non-UTF-8 blobs, and the
  definition-root guard.
- `apps/desktop/src/composables/useAppTaskCreation.test.ts` — the modal offers
  the on-disk workflows before anything touches the network, then the ones a
  fetched origin adds; a failed fetch leaves it usable.
- `apps/desktop/src/stores/kanna.querySnapshot.test.ts` and `init.test.ts` — a
  plain reload keeps cached definitions, a `repos`-scoped change forces a
  re-read, a newly appearing repo is resolved regardless.
- `apps/desktop/tests/e2e/mock/stage-order.test.ts` still covers the
  user-visible half: an imported repo's stage order renders from its committed
  config.

## Known trade-off

A `stage_order` edit pushed to a repo's `.kanna/config.json` reaches the sidebar
on cold start, repo add/rename, reconnect, or the next new-task modal open for
that repo — not within the server's 30 s definition TTL as a side effect of
unrelated task activity. Nothing notifies the server that a repo's committed
config moved, so the old freshness came from re-resolving on traffic that had
nothing to do with definitions.
