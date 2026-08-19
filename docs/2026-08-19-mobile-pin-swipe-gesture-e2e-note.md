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
`src/components/taskPinSwipe.test.ts` (the offset-aware helpers).
