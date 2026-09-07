# Testing infrastructure: what this task killed, and what is still broken

**2026-09-06.** Written while eradicating the Node-24 bare-`fetch` / `lan_trust`
403 class. The class is dead and guarded; this is the honest account of what
remains, so the next person does not rediscover it one callsite at a time.

## The class that was killed

Since the local-boundary hardening (`ff2fe6312`, PR #1306), `kanna-server`
classifies every request on its real listener: one carrying `Origin` or any
`Sec-Fetch-*` header is browser-originated and must present the desktop's local
control credential (`crates/kanna-server/src/http_api/lan_trust.rs`). Node 24's
global `fetch` is undici, which attaches `Sec-Fetch-Mode: cors` to every
request it sends. So every Node test harness — an ordinary local process
already holding the user's authority — was classified as a browser and refused
403.

It was diagnosed and patched four separate times in one week (PR #1321, task
b08e50ff, task ef8edab4, and the still-broken
`mock/desktop-server-phase3.test.ts`), each time as one callsite rather than as
a class, because nothing made the *rule* checkable.

**Why it kept coming back.** Hosted CI was deliberately removed
(`tools/kd/tests/ci-workflow.test.ts`); verification is local `pnpm test` plus
`./kd test rust`. But the desktop, mobile, and remote E2E lanes are *not* in
either — they are separate opt-in commands (`./kd test desktop-e2e`,
`./kd test remote-e2e`, `pnpm --dir apps/mobile test:e2e`). Nobody runs them
except the task that needs them, so each task met the 403 fresh, fixed its own
call, and moved on.

The fix is therefore not only the migration but the *placement* of the guard:
`tools/kd/tests/kanna-test-fetch.contract.test.ts` is a source scan, so it runs
in `pnpm test` — the lane that actually runs every time — and fails on a new
bare `fetch` at a Kanna URL without needing an app, a daemon, or a simulator.

**A bug both copies carried.** Consolidating the two implementations surfaced
one: `new Response(body, { status: 204 })` throws `Invalid response status
code`, because 204 is a null-body status. `kanna-server` answers 204 from
several action routes, so every duplicated copy would have crashed there — it
had simply never been called on one. One implementation means one place to fix
it, and a test that pins it.

## Still broken, with owners

| Item | Owner | State |
|---|---|---|
| Real-E2E startup fails at `about:blank` | task 039fe10a | Open, reproduces on the MBP |
| E2E steals window focus during a run | task 9040ad7d | Open, this machine (Mac Studio) |
| Relay-lane geometry harness fix | task b8b561d5 | Written, awaiting review |
| `local-transfer-headless-engine.test.ts` fetch migration | task b08e50ff | In revision |
| `pty-runtime-status.test.ts` fetch migration | task ef8edab4 | In review |

The last two are listed in `PENDING_MIGRATIONS` in the guard, which fails once
they land — the entry expires itself rather than becoming a permanent
carve-out.

## The desktop mock lane is red for reasons that are not this class

Verified on 2026-09-06 on the Mac Studio, after the migration. No `403` appears
anywhere in these logs: every request now reaches a route handler, which is the
migration working. What it uncovered is a lane that was already red underneath.

| Suite | Result | Root cause |
|---|---|---|
| `mock/desktop-server-phase3.test.ts` | 2/2 pass | Was 403; fixed here |
| `mock/external-task-create.test.ts` | 3/3 pass | — |
| `mock/task-lifecycle.test.ts` | 6/10 pass | Four fail on repository-setup and worktree timing ("Timed out waiting for repository setup task to settle"). The snapshot test this task touched passes. |
| `mock/phase2-server-writes.test.ts` | 1/4 pass | `POST /v1/tasks` answers `500 stage not found in workflow: review`; the other two failures cascade from it. The credentialed webview call this task added is never reached, so it is **unverified end to end**. |
| `mock/stage-advance.test.ts` | 0/7 pass | Every action answers `500 compiled resource not found: .kanna/workflows/durable-two-stage-e2e.json` (and `durable-revision-e2e.json`). |

The two 500 shapes look like one defect in how a fixture repo's `.kanna/workflows/*.json`
is resolved or compiled for an E2E-created task. It is a different defect from
the one this task was given, so it is recorded rather than fixed. It deserves
its own task, and it is probably part of why nobody noticed the 403s: a lane
that is already failing teaches people not to read its failures.

## Found in the sweep, deliberately not fixed

Each of these is real and out of this task's scope. None is urgent.

1. **`apps/desktop/tests/e2e` is never type-checked.**
   `apps/desktop/tsconfig.json` includes only `src/**`, and the e2e tree is run
   by `tsx`, which strips types without checking them. `pnpm exec tsc --noEmit`
   in `apps/desktop` passes today while the e2e tree holds roughly sixteen type
   errors (`run.ts`, `pty-session.test.ts`, `helpers/webdriver.ts`,
   `agentProviderIsolation.ts`, and others). A harness that cannot be
   type-checked is a harness where a rename lands as a runtime failure two
   hours into a suite.

2. **`startTestKannaServer` (`apps/desktop/tests/e2e/helpers/kannaServer.ts`)
   has no callers.** Its readiness probe was one of the 403 casualties and
   nothing noticed, because nothing runs it. It is migrated here rather than
   deleted; deleting dead harness code is its own decision.

3. **Three `xcrun` wrappers replace the tool's error with advice**:
   `apps/mobile/e2e/helpers/device.ts:183`, `simulator.ts:105`,
   `release-install.ts:76`. Each catches an `execFileAsync` rejection and
   throws a hand-written "confirm Developer Mode is enabled" message, dropping
   the actual `xcrun` stderr. The advice is good; the discarded stderr is what
   you need when the advice does not apply. They are not retry loops, so they
   were left alone here.

4. **The guard cannot see a fully dynamic URL inside a wrapper.** It has two
   detectors: a Kanna route path or Kanna-only base identifier in the call's
   argument text, and the global handed to another client as its transport
   (`createLanTransport(baseUrl, fetch)` — the shape that hid a 403 in
   `apps/mobile/e2e/agentProviderInventory.integration.test.tsx` and that a
   URL-based scan can never see). What neither catches is a `FetchLike`
   *adapter* that closes over `fetch` and forwards an opaque `input` —
   `lan-layer.e2e.test.ts`'s `nodeFetch` was exactly this. That one is migrated
   by hand; a future one will not be caught. A type-aware lint would close it,
   and the repo has no ESLint lane to put it in.

## Loud failures added here

- `waitForBuffyIdToken` / `signInWithPassword`
  (`tests/remote-e2e/src/firebaseAuth.ts`) now carry the Auth emulator's own
  rejection — status, body, or transport error — into the timeout, plus where
  the emulator writes `firebase-debug.log`. This is the seeding failure that
  blocked task b8b561d5 three times with no captured reason.
- `waitFor` (`apps/mobile/e2e/helpers/wait.ts`) hands its probe a
  `recordReason` callback and puts the last reason in the timeout. Its Appium,
  Metro, and native-geometry probes now use it.
