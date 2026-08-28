# Mobile task-input queue E2E gap (2026-08-26)

The draft-held input fix crosses React Native → LAN/relay HTTP → `kanna-server` → daemon → a provider TUI PTY. The repository does not currently have an end-to-end harness that can type an unfinished draft into a real desktop terminal while driving the mobile app, hold multiple logical messages, then submit the desktop draft and inspect both the provider composer boundaries and the server-owned SQLite ledger. The mobile E2E driver can render and send, while daemon tests can own a PTY, but neither can coordinate the other side's native UI/keyboard today.

A complete E2E becomes practical when the mobile driver can target a `kd dev up --mobile` worktree instance and the desktop WebDriver exposes raw composer draft/submission actions for the same task. The test should type a desktop draft, send two mobile messages, assert the mobile queued indicator and reason, submit the desktop draft, assert three distinct provider submissions, and read two distinct `task_input` rows.

Narrower coverage added meanwhile:

- Mobile transport tests pin the `202 queued` response and prevent retries; the task-screen component test pins the queued count and held-by-draft explanation.
- The server route test holds two inputs through a fake daemon boundary, verifies visible FIFO queue state, and promotes the releases into two ordered `task_input` rows.
- Daemon coordination tests pin the held queue's FIFO message boundaries. The writer now emits one release edge and applies a post-Enter processing fence for each held logical message; the server tests consume those edges independently.
