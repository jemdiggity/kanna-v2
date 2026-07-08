# Undo Close E2E Coverage Gap

The server-backed undo-close fix for packaged builds is covered by focused store tests:

- `apps/desktop/src/stores/serverBoundary.test.ts` now prevents `taskCloseActions.ts` from using the frontend database boundary.
- `apps/desktop/src/stores/kanna.taskBaseBranch.test.ts` covers retrying repo unhide after a failed server call and preserving the undo state.

I did not add Playwright E2E coverage in this task because the existing E2E SQL tunnel was also being constrained to loopback-only in the same review batch, and adding a new browser scenario would couple the undo-close assertion to that debug-only SQL setup. A future E2E should exercise the real server-backed close/reopen flow through UI shortcuts or command palette actions without direct SQL setup once the test fixture can seed closed tasks through server APIs.
