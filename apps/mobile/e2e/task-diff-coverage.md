# Mobile Task Diff E2E Coverage

The mobile task diff crosses three boundaries: the task action menu opens a
fullscreen WebView modal (`TaskDiffPreview`), the mobile client fetches
`GET /v1/tasks/{task_id}/diff` either over LAN with the paired device
credential headers (`X-Kanna-Device-Id` / `X-Kanna-Device-Secret`, issued at
pairing claim time and verified against the desktop pairing store) or through
the authenticated relay as a fallback, and `kanna-server` computes the
unified patch with `git` inside the task's worktree (merge-base against the
task `base_ref` / repo default branch, plus uncommitted and untracked
changes).

## Why the full device journey is not automated yet

The end-to-end journey needs the relay Appium lane
(`pnpm --dir apps/mobile run test:e2e:relay`) to drive the native iOS action
sheet ("View Diff") and then inspect the diff WebView document. That lane is
currently blocked locally by the WebDriverAgent visibility limitation recorded
in `file-preview-coverage.md`: the driver cannot expose the rendered React
Native controls, so no spec in the lane can reach the task screen's action
menu. Extending `relay-task-flow.e2e.ts` with a diff journey becomes possible
as soon as that documented limitation is lifted; the relay harness's scripted
tasks would additionally need their `worktreePath` initialized as a git
repository with one commit so the server-side diff has a merge base.

## Deterministic coverage in place today

- `crates/kanna-server/src/task_diff.rs` unit tests compute real `git` diffs
  in temp worktrees: merge-base scoping, task `base_ref` precedence over the
  repo default branch, uncommitted + untracked inclusion, branch-name task
  resolution, workspace-unavailable mapping, and 1 MiB truncation.
- `crates/kanna-server/src/http_api/tests/core_routes.rs` task-diff route
  tests drive the real router against a real git worktree, including the
  actual authenticated relay dispatch path
  (`dispatch_authenticated_http_invoke`) and the 401 fail-closed response for
  ordinary LAN HTTP requests.
- `apps/mobile/src/lib/transports/remoteTransport.test.ts` fixes the exact
  wire call (`GET /v1/tasks/{localTaskId}/diff` to the owner desktop), and
  `lanTransport.test.ts` proves the LAN transport sends the paired device
  credential headers and fails closed without them. `cloudLanClient.test.ts`
  covers LAN-first routing with relay fallback for merged cloud/LAN task
  projections. Server-side, the pairing-secret issuance and the trusted-LAN
  middleware are covered by `crates/kanna-server/src/pairing.rs` tests and
  the task-diff route tests (valid secret 200, wrong/unpaired secret 401).
- `apps/mobile/src/screens/TaskScreen.test.tsx` covers the "View Diff" action
  opening and closing the modal; `TaskDiffPreview.test.tsx` and
  `buildTaskDiffDocument.test.ts` cover load/error/retry states, the
  desktop-parity scope controls (branch all/staged/committed and working
  all/unstaged/staged refetch with the right request), and the rendered
  patch document (per-file sections, add/del classification, escaping,
  truncation notice, locked-down WebView navigation). Server-side scope
  semantics are pinned by `crates/kanna-server/src/task_diff.rs` tests over
  a layered fixture (committed + staged + unstaged + untracked changes).
