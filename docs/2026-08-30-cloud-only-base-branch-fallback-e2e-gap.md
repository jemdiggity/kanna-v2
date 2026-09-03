# Cloud-Only Repo Base-Branch Fallback E2E Gap

The new-task modal's fallback for cloud-only repos whose remote cannot be
listed (task d66c4550) is not covered end to end.

The behavior: opening the new-task modal for a repo that exists only in the
desktop cloud task index (a sidebar project made of another desktop's remote
tasks, with no local repo row) lists base branches with
`git ls-remote <remote_url>`. When that fails — a private repo the machine's
active git credential cannot see, or an unreachable network — the modal now
falls back to offering `origin/<default_branch>` from the owning desktop's
published snapshot and surfaces the listing failure as a toast, instead of
leaving the branch list empty and the Create button permanently disabled.

The blocker is the E2E harness: the mock E2E suite
(`apps/desktop/tests/e2e/mock/new-task-modal.test.ts`) exercises the modal only
against local repos, and `tauri-mock.ts` stubs `git_list_remote_base_branches`
with a fixed success value; neither harness can put a cloud-only repo (a
Firestore-backed `DesktopCloudSnapshot` from a second desktop identity) into
the sidebar. The real E2E runner has no second-desktop cloud task index
fixture either.

To make this testable end to end, the harness would need a seeded cloud
snapshot for a repo with no local row (a second desktop publishing tasks
through the Firestore emulator, or a mock-level injection point for
`remoteSnapshot`) plus a failing `git_list_remote_base_branches` stub, then
assert the modal opens with `origin/<published default>` preselected and the
Create button enabled.

Narrower coverage added instead, in
`apps/desktop/src/composables/useAppTaskCreation.test.ts`:

- a failing `git_list_remote_base_branches` falls back to the published
  default branch and raises the `toasts.remoteBaseBranchesFailed` toast;
- a cloud repo with no remote URL offers the published default branch without
  attempting a remote listing and without a toast.
