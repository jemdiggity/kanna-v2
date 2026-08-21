# Mobile repo-command recovery

## Goal

Keep Tasks-screen navigation usable when a successfully launched repo command's created task cannot immediately be loaded, and make that failure visibly recoverable in place.

## Scope and constraints

- Audit repo-command guards so only genuinely conflicting command launches are refused; repo selection and sibling user actions must not become silent no-ops because a task load is pending.
- Provide reachable retry/dismiss recovery that clears `pendingRepoCommandTask`, and tolerate a bounded created-task visibility race.
- Preserve machine/repo ownership when mobile aggregates repositories: a repo command or task creation must target a desktop that actually has the selected repo, or the UI must scope the choice accordingly. A machine-lacks-repo failure must be visible and recoverable rather than becoming a pending-task latch.
- Do not implement repository cloning, checkout, registration, or add-repo UI. The owner assigned that explicitly confirmed flow to a separate feature task; this task may only explain the mismatch and recover safely.
- Add mobile store/controller coverage for failed-load navigation, recovery, refusal of a second command while one is running, and command/task creation attempted through a machine that lacks the repo.
- This is JS-only: do not change mobile `runtimeVersion`.

The machine/repo ownership requirement was added by the manager on 2026-08-21 after confirming the owner repro: `kanji-kongbu` (`00fe1fc0`) existed only on the local desktop, while the operation was attempted through the Mac Studio, which also rejected ordinary task creation for that repo.

The manager clarified on 2026-08-21 that the eventual confirmed “check this repo out on that machine” UX is out of scope and will be tracked separately.

## Done when

The regression and recovery cases pass in mobile tests, a running command still prevents a duplicate launch with visible state, and `pnpm --filter @kanna/mobile test` plus `pnpm test` pass.
