# iOS Simulator verification for c21c9405

Verified on 2026-08-23 in an iPhone 17 Pro simulator using the task's `./kd dev up --mobile --seed` stack. The screenshots exercise the real `SwipeableTaskCard` in the running app; a temporary E2E-only task fixture supplied stable card content for the captures and was removed afterward.

## Failure reproduction

- [Pre-fix crash](c21c9405-screenshots/pre-fix-native-js-driver-crash.png): with Reduce Motion off, crossing the commit threshold reproduced React Native's uncaught “Attempting to run JS driven animation on animated node that has been moved to native” error at `SwipeableTaskCard.tsx`. This confirms the #1204 mixed-driver diagnosis.

## Fixed build

| Reduce Motion | State | Observation |
|---|---|---|
| Off | [Mid-swipe](c21c9405-screenshots/reduce-motion-off-mid-swipe.png) | The opaque card translates left and reveals only a solid blue gutter; no action pixels appear through the card. |
| Off | [Armed](c21c9405-screenshots/reduce-motion-off-armed.png) | The solid armed-blue pill and `Pin` label occupy the vacated gutter, disjoint from all card text. |
| Off | [Released](c21c9405-screenshots/reduce-motion-off-released.png) | Pin completes without an exception and the card returns fully opaque to rest. |
| On | [Mid-swipe](c21c9405-screenshots/reduce-motion-on-mid-swipe.png) | The card still translates instead of fading; the revealed gutter is solid and cannot overlay card content. |
| On | [Armed](c21c9405-screenshots/reduce-motion-on-armed.png) | The action remains a separate solid-blue region and its label shares no pixels with the task id or title. |
| On | [Released](c21c9405-screenshots/reduce-motion-on-released.png) | The short timing completion finishes without a crash and restores the opaque resting card. |

All six fixed screenshots were visually inspected at full size. Both motion modes completed swipe-to-pin without a crash; no card/action overlap, text collision, or translucent action color remains.
