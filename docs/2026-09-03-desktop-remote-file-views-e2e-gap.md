# Desktop remote file views E2E gap

2026-09-03. Written with task `430270e2`, which routes desktop tree, file-content, and diff reads to the task-owning machine.

## Covered behavior

The desktop relay-client test drives the real stream request framing and asserts owner-local task routing for the task-scoped `/browse`, `/files/content`, and `/diff` routes, including paginated directory results. Existing `kanna-server` HTTP route tests exercise authenticated relay dispatch for task files, directory browsing, and task diffs against real worktrees. Desktop component tests prove that remote loaders bypass all local filesystem/git commands and that tree, file, and diff failures render explicit unavailable states. The mock WebDriver suite additionally opens a selected local task whose worktree path does not exist and asserts that the explorer shows the unavailable state without repo-root content or `(empty)`.

## Missing cross-machine proof

The desktop WebDriver harness runs one desktop/server and can inject another machine's published task snapshot, but it cannot currently stand up a second independently owned worktree behind an authenticated relay tunnel and control that tunnel's HTTP responses. The real cloud suite similarly has one desktop app process, so an injected remote task has no live owner server to answer file requests.

A full E2E needs a two-desktop relay fixture: desktop B publishes a task backed by a real worktree, desktop A selects that cloud task, and the harness records B's `/browse`, `/files/content`, and `/diff` requests while A opens the explorer, previews a file, and opens the diff. The same fixture should stop B (or remove its worktree) and assert all three explicit unavailable states on A.
