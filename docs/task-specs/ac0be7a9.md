# Task ac0be7a9: recover dead task sessions from every client

## Goal

Make a task whose daemon PTY session disappeared while its latest stage run still says `running` recoverable through one server-owned operation used by MCP/CLI, mobile task selection, and desktop attachment. Restart the same stage in the same worktree, preserve supported provider context, and report real resume provenance or an exact fallback reason.

## Scope and constraints

- Mobile automatically recovers on selection, acknowledges through the shared resume API over LAN or relay, and then retries attachment every 1 second without depending on a collection/cloud refresh. It shows "restarting session…" while pending; after 30 seconds it shows "Session restart timed out; select the task again to retry" and releases the attempt so re-selection can retry. Immediate server failures retain their exact reason.
- Preserve the resume action's structured error code through both mobile stream transports so agent and PTY views recognize the same missing-session condition.
- Depend on task `a08c6fab` for the server-owned running-run recovery semantics, provider resume/fallback provenance, desktop migration to the shared action, tool-catalog contract, boundary documentation, and their server/desktop tests. Rebase this task onto `main` after `a08c6fab` merges; do not duplicate that implementation here.
- Add cross-boundary E2E coverage, or a dated E2E-gap note with the exact limitation and narrower coverage. Visually verify the real mobile app via `./kd`; if `./kd mobile run` cannot target a simulator, record the exact failing command and result here.
- Keep this JS-only unless implementation genuinely requires native changes; JS-only work must not change mobile `runtimeVersion`.
- Do not broaden into unrelated lifecycle or UI refactors.

## Terms update

On 2026-09-03, the task manager directed that sibling task `a08c6fab`
owns the already-completed server/desktop half: accepting an orphaned
still-`running` run, proving daemon absence, preserving provider context,
recording honest resume provenance, and routing desktop recovery through the
server. The manager said this task's remaining scope is “the mobile
select-to-recover UX and any server/catalog surface it needs,” layered on that
commit, and that this branch should expect a rebase after the sibling merges.
This replaces the original requirement to reimplement those server and desktop
changes in this branch; the end-to-end outcome still includes them through the
declared dependency.

Later on 2026-09-03, the task manager reported that `a08c6fab` had merged to
`origin/main` as `2a36fd6f3` through PR #1269 and directed this task to finish
against that merged server implementation. This branch is therefore rebased
onto that exact `origin/main` lineage before final combined verification.

## Done when

After rebasing onto `a08c6fab`, dead-under-`running` sessions recover from `kanna_resume_task`, mobile selection, and desktop through the shared server path; provider resume/fallback provenance is truthful; mobile replaces the bare missing-session error with progress and actionable failure UI over LAN and relay; contract/catalog/tests are updated across the two tasks; required TypeScript checks and `./kd test all` pass, with mobile visual verification or its exact blocker recorded below.

## Verification record

- Revision-round recovery completion is client-driven and bounded: after the
  resume acknowledgement, both PTY and structured-agent views retry attachment
  every 1 second until a non-error stream frame arrives. If none arrives in 30
  seconds, the stalled subscription closes, the UI shows “Session restart
  timed out; select the task again to retry”, and re-selecting the task can
  issue a fresh resume request. Controller tests cover this without a cloud
  task subscription or manual `refresh()`, plus terminal timeout/retry and
  structured-agent completion.
- Mobile visual verification is blocked by the canonical launcher having no
  simulator target. Exact command: `./kd mobile run`; exact result:
  `mobile run requires --device`. `./kd mobile run --help` confirms that
  `--device` targets a physical iOS device only. No screenshot was captured.
- The mobile change is JS/TypeScript-only. Native code/config/dependencies and
  every `runtimeVersion` remain unchanged.
- Mobile TypeScript passed. Six focused suites passed with 338 tests, covering
  the controller, LAN/relay transports, and rendered restart states; after the
  revision, the controller-only suite passed all 210 tests.
- Before the dependency rebase, the complete mobile suite passed: 1,814 tests
  passed and 3 integration tests were intentionally skipped.
- The remaining native relay recovery E2E limitation and narrower automated
  coverage are recorded in
  `docs/2026-09-03-mobile-dead-session-recovery-e2e-gap.md`.
- After rebasing onto `2a36fd6f3`, combined focused verification passed: mobile
  TypeScript plus 338 targeted tests, 19 desktop session-store tests, and 4
  server restart-recovery tests.
- `./kd test all` passed after the rebase, including the complete mobile suite
  (1,816 passed, 3 intentionally skipped), desktop production build and
  typecheck, canonical Rust tests, and canonical daemon tests.
- After the revision changes, `./kd test all` passed again, including the
  complete mobile suite (1,817 passed, 3 intentionally skipped), remote E2E,
  desktop production build and typecheck, canonical Rust tests, and the
  serialized canonical daemon lane.
