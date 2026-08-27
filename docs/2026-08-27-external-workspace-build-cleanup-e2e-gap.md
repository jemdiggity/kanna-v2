# External workspace build cleanup E2E gap (2026-08-27)

The production boundary is a task close or stage transition spawning a detached
`td-<branch>` PTY, running the repository teardown list in a worktree, and then
removing that worktree. A hermetic E2E cannot currently configure a disposable
machine-local primary-checkout hook for that server-owned worktree or substitute
a fake external volume without mutating the developer machine's ignored setup.
Running the test against `/Volumes/VHS` would also make a failure destructive to
real per-task build data.

Narrower coverage in
`tools/kd/tests/external-build-clean.integration.test.ts` runs the committed
machine-local setup template for two real Git repositories, invokes the same
`cleanWorkspace` runtime used by `./kd clean --all` for the departed workspace,
and proves its external target disappears while the live sibling target and link
remain. `tools/kd/tests/clean-pages-release.test.ts` separately pins exact-name
refusal and dangling-link behavior.

Full E2E becomes practical when the server test harness can inject a
primary-checkout-local setup path (or an equivalent disposable workspace-build
layout) into a created task and expose completion of its detached teardown
session before fixture cleanup.
