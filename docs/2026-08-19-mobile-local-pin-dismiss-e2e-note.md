# Mobile pin and Activity dismiss become phone-local

Owner decision (2026-08-19): mobile pinning "can just use local storage", and
"Dismiss can work the same way and again it doesn't need a dismiss button, just
swiping." Both mobile actions stop calling the desktop and become records this
phone keeps for itself.

## What changed

- `apps/mobile/src/state/taskListPreferences.ts` holds the record and its pure
  operations (toggle, dismiss, prune, seed);
  `taskListPreferencesStorage.ts` persists it under
  `kanna.mobile.task-list.v1`, with the same corruption protection quick
  replies gained in #1106 — a payload it cannot read is copied to a recovery
  key before anything replaces it, and never silently becomes "no pins".
- The swipe writes that record and the list reorders (or drops the row) from
  the write alone. The optimistic pin overlay from #1122/#1124
  (`setTaskPinIntent`, the intent projections, the `Pinning…`/`Dismissing…`
  pending states) is gone, because there is no server answer left to
  reconcile against. The #1124 gesture fixes — offset-aware close, tap to
  close — are untouched.
- The dismiss button is gone. Swiping is the only dismiss affordance; the row
  keeps a `dismiss` accessibility action so VoiceOver still reaches it, exactly
  as pinning already worked.
- Pinned rows are marked by their outline (`#4C6FA8` instead of `#20304C`) —
  no glyph or badge, since position already carries most of the signal.

## Accepted divergence

Mobile pins no longer sync with desktop pins or across phones and reinstalls,
and a mobile dismiss does not mark the task read on the desktop: desktop unread
state stays authoritative for desktop UI and for supervisors. This is the
owner's explicit call. The server pin API and desktop pinning are unchanged;
mobile just stops calling them. The now-unused mobile transport routes
(`pinTask`/`unpinTask` in `lanTransport`, `remoteTransport`, `cloudLanClient`,
and the client facade) were removed because nothing else consumed them.
`markTaskRead` stays: the task-detail dwell still marks a task read on the
desktop when it is actually opened.

## Retention

Entries are seeded and pruned against the authoritative all-open-tasks snapshot
(`listRecentTasks`, or an authoritative cloud publication):

- pins drop when the snapshot covers their repo and no longer contains the task;
- dismissals drop when the task is gone, is no longer `unread`, or carries
  newer activity than the dismissed generation — which is why a dismissal is a
  `(taskId, activityRevision)` pair rather than a bare id.

Pruning is repo-scoped on purpose: a phone reading one machine must not treat
another machine's tasks as gone. The cost is a pin whose repo has no other open
task lingering until that repo shows one again.

One-time migration: the first authoritative snapshot with tasks in it folds the
desktop's own `pinned`/`pinOrder` into the phone's record, so pins made before
this change survive the switch. It runs once, so a later unpin on the phone is
not undone by the next snapshot that still reports the desktop pin.

## Coverage

- `src/state/taskListPreferences.test.ts` — toggle, dismiss/resurface on a
  newer generation, revisionless dismissals, prune, seed, and payload
  normalization.
- `src/state/taskListPreferencesStorage.test.ts` — round-trip, refusal to save
  before the record is read, preservation of malformed/unknown-version/
  unreadable payloads, the blocked save when preservation itself fails, and the
  retry before replacement.
- `src/state/mobileController.test.ts` — local pin/unpin with no server write,
  the failed local write reported on the row, pins surviving snapshots that
  never mention them, the one-time seed, prune vs. repos the snapshot does not
  cover, and dismissal leaving the desktop unread.
- `src/screens/taskPinOrder.test.ts`, `src/screens/TasksScreen.test.tsx`,
  `src/screens/taskTreeRows.test.ts` — ordering and Activity visibility from
  the local record, explicitly ignoring the desktop's own pin columns.
- `src/components/TaskCard.test.tsx`,
  `src/components/SwipeableTaskCard.test.tsx` — the pinned outline, the removed
  dismiss button, the accessibility actions, and the labels with no pending
  step.
- `src/navigation/RootNavigator.integration.test.tsx` — the swipe → controller
  → store → reordered rows wiring, asserting what was written to storage.
- `tests/remote-e2e/src/lan-layer.e2e.test.ts` — against the real
  `kanna-server` LAN API: a phone-local pin lifts the row and leaves the
  desktop's pin columns untouched, and a local dismiss hides the row while
  `/v1/tasks/recent` still reports it unread, with newer activity bringing it
  back. The two specs that asserted the mobile pin round-trip
  (see `2026-08-19-mobile-pin-swipe-gesture-e2e-note.md`) are retired: the
  behaviour they covered no longer exists.
- `apps/mobile/e2e/specs/smoke/list-detail-back.e2e.ts` — the Appium journey now
  requires the swipe to lift the row *and* the desktop pin state to stay put,
  and the dismiss journey requires the desktop to stay unread. It puts the pin
  back through the app, since the phone is the only place the pin lives.

## Device limitation (unchanged)

The physical Appium journey was not executed here for the same reason as the
earlier pin notes: it needs an installed Expo development client, Appium/
XCUITest, and a live PTY fixture, and device installation is out of scope. The
helpers' own vitest coverage (`e2e/specs/smoke/list-detail-back.test.ts`) runs,
including a case that fails if a local pin ever reaches the desktop's pin
state.

This change is JS-only: no native code, native config, Expo SDK, or native
dependency moved, so `runtimeVersion` is unchanged and the change is
OTA-deliverable.
