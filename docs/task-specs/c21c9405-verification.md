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

All six fixed `Pin` screenshots were visually inspected at full size. Both motion modes completed swipe-to-pin without a crash; no card/action overlap, text collision, or translucent action color remains.

## Original pinned-card `Unpin` states

Revision verification used the same real iOS Simulator app and a temporary E2E-only pinned task fixture, removed after capture. The gesture completed through the app's actual phone-local pin callback in each motion mode.

| Reduce Motion | State | Observation |
|---|---|---|
| Off | [Mid-swipe](c21c9405-screenshots/reduce-motion-off-unpin-mid-swipe.png) | The opaque card translates left while the solid idle dark-red action is revealed only in the vacated gutter; the partially revealed label is clipped by the card boundary rather than drawn over card text. |
| Off | [Armed](c21c9405-screenshots/reduce-motion-off-unpin-armed.png) | The armed red pill is solid and scaled, with the full `Unpin` label wholly inside the gutter and disjoint from the task id and title. |
| Off | [Released](c21c9405-screenshots/reduce-motion-off-unpin-released.png) | Unpin completes without an exception, removes the pinned outline, and returns the fully opaque card to rest with no action pixels visible. |
| On | [Mid-swipe](c21c9405-screenshots/reduce-motion-on-unpin-mid-swipe.png) | The reduced-motion path still translates the opaque card; the idle dark-red action remains solid and its clipped label never shares pixels with card content. |
| On | [Armed](c21c9405-screenshots/reduce-motion-on-unpin-armed.png) | The short non-springy path reveals a separate solid armed-red pill; `Unpin`, the task id, and the title occupy disjoint regions. |
| On | [Released](c21c9405-screenshots/reduce-motion-on-unpin-released.png) | Unpin completes without a crash, clears the pinned outline, and restores the opaque resting row with the action fully hidden. |

All six `Unpin` screenshots were inspected at full size. The idle-to-armed red treatment is solid in both motion modes, card and action pixels remain disjoint throughout, the action label never collides with card text, and both releases complete without a crash. The captures revealed no additional code defect, so this revision adds no product or automated-test change.
