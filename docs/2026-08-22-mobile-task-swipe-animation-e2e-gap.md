# Mobile task swipe animation E2E gap (2026-08-22)

The pin/unpin and Activity-dismiss swipe animations need final verification on a physical iPhone. The Appium smoke journey can perform the gesture and assert the resulting local state, but its element snapshots cannot prove frame pacing, spring character, continuous underlay emphasis, reduced-motion transitions, or the visual collapse between list rows. This task did not have a compatible installed development client and physical-device Appium/XCUITest session available.

Narrower automated coverage lives in `apps/mobile/src/components/taskRowSwipe.test.ts` and `SwipeableTaskCard.test.tsx`. It drives the real `PanResponder` configuration and verifies the commit threshold, armed/disarmed emphasis, spring-back path, animation-before-callback ordering, pin/dismiss completion, layout-animation selection, and the reduced-motion fade path. The existing smoke journey continues to cover swipe-to-local-state wiring and resulting pin order/dismissal.

## Manual iPhone checklist

Start the mobile environment through `./kd dev up --mobile`, install/open the matching dev client, and test with a populated Tasks list and Recent/Activity list:

1. Slowly drag a task left. Confirm the action label grows and brightens continuously, becomes distinctly armed at the commit threshold, and disarms when dragged back inside it.
2. Release inside the threshold. Confirm the card springs cleanly to rest without changing pin state and without a dropped frame while the list is scrolling.
3. Release past the threshold. Confirm the card gives a springy snap, the task moves to/from the pinned section with a spring-settled reorder, and the card remains tappable afterward.
4. Swipe an Activity row past the threshold. Confirm it slides fully left and the vacated height collapses smoothly, with surrounding rows closing the gap rather than jumping.
5. Repeat both committed actions while storage is unavailable or forced to fail. Confirm the row returns and its inline error remains visible.
6. Enable iOS Settings → Accessibility → Motion → Reduce Motion, relaunch or toggle it while Kanna is open, and repeat. Confirm translation/scaling/layout springs are absent and the actions use short fades only.
7. Disable Reduce Motion and confirm the physical animations return.

## Haptic limitation

`expo-haptics` is not currently a mobile dependency. Adding it would change the native runtime and require a `runtimeVersion` bump, which this task explicitly forbids. The threshold haptic is therefore intentionally omitted; the threshold's scale/opacity emphasis provides the JS-only feedback.
