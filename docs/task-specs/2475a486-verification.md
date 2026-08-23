# iOS Simulator verification for 2475a486

Verified on 2026-08-23 in the dedicated `Kanna 2475a486` iPhone 17 Pro simulator using the task's `./kd dev up --mobile` stack. Before the terminal-settle rewrite, a real edge gesture reproduced the reported stable partial translation with clipped content and a dead right gutter; before container start-capture, the preview WebView retained the edge gesture instead of revealing its file list.

## Fixed build

| Evidence | Technique | Observation |
|---|---|---|
| [Below-threshold release](2475a486-screenshots/a-below-threshold-settled.png) | Real W3C touch: pointer down, four 50 ms-spaced moves totaling 40 points, pointer up, then a one-second settle. | The same `packages/core/src` view remains exactly full-width at zero with no clipped header or gutter. |
| [Forward swipe with no history](2475a486-screenshots/b-forward-no-history-settled.png) | Real W3C right-edge touch with four 50 ms-spaced leftward moves, pointer up, then a one-second settle. Explicit directory navigation cleared forward history first. | The `packages/core/src` view remains exactly full-width at zero; no dead gutter or transition is left behind. |
| [Preview back mid-transition](2475a486-screenshots/c-preview-back-mid-fixture.png) | Temporary development-only fixture set the real transition's animated offset to 30% for the screenshot; the fixture was removed before final checks. | The file preview slides right while its `packages/core` file list is visibly sliding in underneath, using the same layered geometry as directory back navigation. |
| [Preview back settled](2475a486-screenshots/c-preview-back-settled.png) | Real W3C left-edge touch over the WebView with four 50 ms-spaced moves, pointer up, then a one-second settle. | The preview closes onto the full-width `packages/core` file list with no gutter. |
| [Directory back settled](2475a486-screenshots/d-directory-back-settled.png) | Real W3C left-edge touch from `packages/core/src`, four 50 ms-spaced moves, pointer up, then a one-second settle. | Ordinary directory back navigation completes on the full-width `packages/core` list with no regression or resting offset. |

Every screenshot above was inspected at full size. None of the settled frames has a resting translation or dead gutter.

## Held-pointer diagnostic

This Appium 2.19/XCUITest stack did not preserve the React Native responder across two `performActions` requests: the diagnostic responder overlay received `onPanResponderMove` with `dx = 95`, followed by `onPanResponderRelease` when the first no-`pointerUp` request ended. A trailing pause likewise completed onto the file list before a held screenshot could be captured. Therefore the owner-approved fixed-offset fixture was used only for the preview's layout mid-state; all required end-state evidence used real gestures.
