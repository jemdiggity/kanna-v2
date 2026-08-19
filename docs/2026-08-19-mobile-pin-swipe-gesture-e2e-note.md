# Mobile pin ordering and swipe gesture E2E note

Two separate pin defects were reported from the staging phone on 2026-08-19:
the pin action stuck but pinned tasks never moved to the top of the list, and
swipe-to-pin did not work at all.

## Ordering — reproduced, fixed, covered

The list ordering defect reproduces without a device. `TasksScreen` sorted the
repo list newest-first and never read `pinned`/`pinOrder`, so a pinned task
kept its creation-time position (and an *older* pinned task therefore sank
towards the bottom, which is what the owner saw). Both transports already
carried the fields — the LAN summaries from `map_task_summary` and the
Firestore-published index through `mapCloudTaskSnapshot` — so this was purely a
client-side projection bug.

Coverage now on the exact seam:

- `src/screens/taskPinOrder.test.ts`, `src/screens/TasksScreen.test.tsx` —
  ordering from the task payload (the TasksScreen case fails against the old
  ordering with the pinned rows last).
- `src/screens/taskTreeRows.test.ts` — a pinned subtask is no longer nested,
  so pinning can lift it.
- `tests/remote-e2e/src/lan-layer.e2e.test.ts` — pins over the real
  `kanna-server` LAN API through the mobile LAN transport, asserts the listing
  payload carries `pinned`/`pinOrder`, and asserts the phone's own repo-list
  ordering puts the pinned task first and restores the previous order on unpin.
- `apps/mobile/e2e/specs/smoke/list-detail-back.e2e.ts` — the physical Appium
  journey now also requires the pinned task to become the first rendered task
  row, not just to flip canonical server state.

## Gesture — not device-reproducible in this task

The swipe row was rebuilt on `PanResponder` (see `SwipeableTaskCard`). The
previous hand-rolled wiring took the responder from a capture-phase handler and
measured the drag from an `onTouchStart` recorded on a view that is not the
touch target, and it never refused `onResponderTerminationRequest`, so the
enclosing vertical task `ScrollView` could reclaim the touch mid-swipe and snap
the row shut. `PanResponder` derives the displacement from React Native's own
touch history and refuses termination — the same shape as
`QuickReplySendControl`, the one gesture in this app known to work on a
physical device.

This task could not execute the physical gesture: the journey needs an
installed Expo development client plus Appium/XCUITest and a live PTY fixture,
and device installation is out of scope here. The narrower coverage that did
run is `src/components/SwipeableTaskCard.test.tsx`, which drives the gesture
config React Native was handed — direction/activation, reveal, cancellation,
and the refusal to hand the gesture back.

It becomes executable with no new harness work: with a compatible dev client
installed and the standard `KANNA_E2E_*` smoke fixture environment present,
`pnpm --filter @kanna/mobile test:e2e:smoke` exercises the swipe, the revealed
action, the canonical server state, and now the resulting row order.

## Follow-up (2026-08-19): closing a revealed row

The owner then reported the other half of the gesture: a row that had been
swiped open stayed open, and a separate rightward swipe did nothing — only one
continuous left-then-right drag closed it. The gesture treated the closed
position as the only starting position: `shouldBeginTaskRowSwipe` claimed
leftward drags only, so a touch that began on an open row was never the row's
to take, and both the translation and the released resting position were
measured from `0` rather than from where the row rested. The helpers now take
that resting offset, and the row snapshots it on `onPanResponderGrant`.

Two close affordances ship: a rightward swipe that brings the row back inside
the reveal threshold, and a tap on the card itself, which a revealed row
consumes to close instead of opening the task. Tapping *another* row does not
close this one — rows do not know about each other, and a list-wide open-row
owner is more than this defect asks for.

The physical-gesture limitation above is unchanged, so the coverage is again
the gesture config React Native is handed:
`src/components/SwipeableTaskCard.test.tsx` (a separate closing gesture, a
rightward drag that stays open, and the tap that closes before it opens) and
`src/components/taskPinSwipe.test.ts` (the offset-aware helpers) — both
superseded by the section below.

## Follow-up (2026-08-19): the swipe commits on release

The owner replaced the grammar rather than the mechanics: "Just swipe and
release for tap/untap is better. If you swipe and hold and swipe the pin button
away and release then no action." So the row no longer rests open at all.

- Dragging left uncovers the action under the finger, as before.
- **Releasing past the commit threshold performs the action** — pin/unpin on
  the task list, dismiss on Activity. There is no revealed button and no second
  tap.
- Dragging back inside the threshold before letting go disarms the swipe, so
  the release does nothing and the row returns to rest. A gesture the row
  *loses* (`onPanResponderTerminate`) performs nothing either: only a release
  commits.
- The action is emphasized exactly at that boundary — it sits back dimmed and
  scaled down while a release would cancel, and snaps to full size and colour
  once a release would commit (`taskRowActionEmphasis`). That is the only
  signal the user gets before letting go, so it is a tested contract, not
  styling.
- No haptic: the app has no haptics dependency, and adding one is native work
  that would force a `runtimeVersion` bump. This change is JS-only and
  OTA-deliverable.

Both swipe lists share the machinery, so both share the grammar: diverging
would mean the same drag means different things one tab apart.

What this retires, because nothing rests open any more: the rightward closing
swipe and the card tap that consumed itself to close a revealed row (both from
the section above), the offset-aware helper parameters they needed, and the
tappable revealed action. A card tap means "open the task" in every state. The
action is now drawn for the eye alone (hidden from the accessibility tree), so
the `taskPinActionSelector` / `activityDismissActionSelector` Appium selectors
— which could no longer resolve — are gone too, and the pin/dismiss journeys
drag and then assert the outcome directly. **VoiceOver keeps pin, unpin, and
dismiss as the row's own accessibility actions: they are now the only
non-gesture path to either.**

The physical-gesture limitation above is still unchanged — no dev client, no
Appium/XCUITest run here — so the coverage is again the gesture config React
Native is handed, now for the new grammar:

- `src/components/SwipeableTaskCard.test.tsx` — release past the threshold
  commits, release after retracting cancels, a drag that never reaches the
  threshold cancels, a terminated gesture cancels, the emphasis flips exactly
  at the threshold, the card tap always opens the task, and the accessibility
  actions still toggle pin/unpin and dismiss.
- `src/components/taskRowSwipe.test.ts` — the pure helpers. It replaces
  `taskPinSwipe.test.ts`: the `taskPinSwipe` alias module existed only to keep
  the pre-swipe pin names alive for that test, and every symbol in it was
  renamed by this change.
- `src/navigation/RootNavigator.integration.test.tsx` — drives the row's real
  pan responder (grant → move → release) through to the phone's own record and
  the reordered rows.
- `e2e/specs/smoke/list-detail-back.test.ts` — the Appium helpers now commit
  with the drag alone; the fixture fails if anything still expects a tap.
