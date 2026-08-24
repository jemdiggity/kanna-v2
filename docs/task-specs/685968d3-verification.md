# Mobile composer Release verification

Verified on 2026-08-23 in the available iPhone 17 Pro simulator with a bundled `Release`-configuration build (`DEV=false`, no Metro-loaded JavaScript). The task-isolated stack came from `./kd dev up --mobile --seed`. The seeded PTY deliberately has no live daemon session, so the verification build used a temporary E2E-only editability override; that override was reverted before the final tests and commit and did not alter composer layout or sizing.

The original controlled-height design made soft-wrap growth depend on `onContentSizeChange`, while its only independent fallback counted literal newlines. The owner's iPhone 15 Release test established that this controlled event path stayed at one line for a soft-wrapped paragraph. In the fixed Release build, native intrinsic layout reported 80 points for three soft-wrapped lines, 120 points at the five-line cap, and 40 points after delete and Send.

| Screenshot | Explicit newlines? | Native input height | Inspection |
|---|---:|---:|---|
| [Soft wrap, 2–3 lines](685968d3-screenshots/a-soft-wrap-2-3-lines.png) | No | 80 pt | One run-on sentence renders as three visible lines and the composer is visibly taller than baseline. |
| [Continued soft wrap past five lines](685968d3-screenshots/b-soft-wrap-over-5-lines.png) | No | 120 pt | Text was appended to the first run-on sentence. The field stays at the five-line ceiling while overflow remains inside it; attachment and Send controls stay bottom-aligned. |
| [Mixed newlines and wrapping](685968d3-screenshots/c-mixed-newlines-and-wrap.png) | Yes — two | 120 pt | Explicit first/final lines plus a soft-wrapped middle paragraph share the same cap without moving the controls. |
| [Delete back down](685968d3-screenshots/d-delete-back-down.png) | No | 40 pt | Replacing the mixed draft with `Short again.` returns the field to its one-line baseline. |
| [Send reset](685968d3-screenshots/e-send-reset.png) | No — empty | 40 pt | Send clears the draft, restores `Reply…`, keeps the keyboard dismissed, and returns the composer to baseline. |

All five screenshots were inspected at full size. Keyboard avoidance keeps the composer above the software keyboard in the editing states, the attachment row remains above it, and no control drifts as the native input grows or caps.

## Owner revision: scrolling and keyboard dismissal

After the owner found that the intrinsic `TextInput` did not scroll internally past its `maxHeight` on an iPhone 15, the Release matrix was repeated with the input intrinsically sized inside a capped native `ScrollView`. The input's native content measurement sets the viewport height; the viewport—not a controlled input height—owns overflow and follows the caret. Real software-keyboard buttons were tapped for the eight-line case because WebDriver value injection does not exercise UIKit caret scrolling.

| Screenshot | Explicit newlines? | Viewport height | Inspection |
|---|---:|---:|---|
| [Soft wrap, 2–3 lines](685968d3-screenshots-round2/a-soft-wrap-2-3-lines.png) | No | 80 pt | The run-on sentence occupies three visible lines and the viewport grows above baseline. |
| [Soft wrap past five lines](685968d3-screenshots-round2/b-soft-wrap-over-5-lines-caret-end.png) | No | 120 pt | The viewport remains capped and follows the caret to the end of the overflowing paragraph. |
| [Mixed newlines and wrapping](685968d3-screenshots-round2/c-mixed-newlines-and-wrap.png) | Yes — two | 120 pt | The final explicit line and caret remain visible after the soft-wrapped middle paragraph. |
| [Delete back down](685968d3-screenshots-round2/d-delete-back-down.png) | No | 40 pt | Replacing the long draft with `Short again.` shrinks to baseline. |
| [Eight lines, caret end](685968d3-screenshots-round2/f-eight-lines-caret-end.png) | Yes — seven | 120 pt | Lines C–H are visible and the caret is visible at the end of H while typing. |
| [Eight lines, scrolled earlier](685968d3-screenshots-round2/g-eight-lines-scrolled-to-earlier-text.png) | Yes — seven | 120 pt | A downward swipe reveals lines A–F and the native scroll indicator, proving earlier text remains reachable. |
| [Keyboard dismissed](685968d3-screenshots-round2/h-keyboard-dismissed-collapsed.png) | Yes — seven | 40 pt | The keyboard is gone, the draft is intact, and the viewport is reset toward its first line at baseline height. |
| [Refocused](685968d3-screenshots-round2/i-refocus-regrown.png) | Yes — seven | 120 pt | Focusing the intact draft restores the capped editing viewport. |
| [Send reset](685968d3-screenshots-round2/e-send-reset.png) | No — empty | 40 pt | Send clears the text and returns the collapsed composer to `Reply…`. |

All nine revision screenshots were inspected at full size. The eight-line screenshots used on-screen key taps; the caret-follow and manual-scroll views are visibly different. The seeded fixture again required a temporary E2E-only editability override. WebDriverAgent cannot dismiss this multiline software keyboard directly, so the verification bundle also used a temporary title-button call to `Keyboard.dismiss()` to trigger the production `keyboardWillHide`/blur path. Both verification-only changes were removed before final tests and commit.

Final checks after reverting the E2E-only editability override:

```text
pnpm --dir apps/mobile test -- src/screens/taskComposerInput.test.ts src/screens/TaskScreen.test.tsx src/screens/TaskScreen.attachment.test.tsx src/screens/TaskScreen.composerIsolation.test.tsx src/screens/TaskScreen.agentComposerIsolation.test.tsx
5 files passed; 107 tests passed

pnpm --dir apps/mobile run typecheck
passed

pnpm --dir apps/mobile test
131 files passed, 2 skipped; 1,741 tests passed, 2 skipped
```

This is a JS-only change. All three values in `apps/mobile/src/mobileEnvironments.json` remain at runtime version `2.2.2`.

## Final revision verification

The complete matrix was repeated on 2026-08-24 after the refocus fix, from Git tip `a3354f0d8ef114326f22198b903d1cd862fdb501`. The embedded bundle was built at `2026-08-24T12:26:04+0900` (5,925,840 bytes) with Xcode's `Release` configuration and run without Metro-loaded JavaScript on an iPhone 17 Pro simulator (iOS 26.5). The measured native viewport width was 242 points. The task fixture, editability override, dev-flavor E2E URL handling/direct route, and title-button keyboard dismissal were verification-only changes; all were reverted before tests and commit. None changed composer sizing, focus, selection, or scrolling code.

| Screenshot | Explicit newlines? | Viewport height | Inspection |
|---|---:|---:|---|
| [Soft wrap, 2–3 lines](685968d3-screenshots-round3/a-soft-wrap-2-3-lines.png) | No | 80 pt | The single paragraph occupies three visible lines and is taller than baseline. |
| [Soft-wrap overflow, caret end](685968d3-screenshots-round3/b-soft-wrap-over-5-lines-caret-end.png) | No | 120 pt | Appending at the end leaves the caret and final text visible while the viewport stays capped. |
| [Soft-wrap overflow, earlier text](685968d3-screenshots-round3/b2-soft-wrap-scrolled-earlier.png) | No | 120 pt | A downward swipe exposes earlier paragraph text, distinct from the caret-end view. |
| [Mixed wrapping and newlines](685968d3-screenshots-round3/c-mixed-newlines-and-wrap.png) | Yes — two | 120 pt | The wrapped middle text and final explicit line share the cap; the final line and caret remain visible. |
| [Delete back down](685968d3-screenshots-round3/d-delete-back-down.png) | No | 40 pt | Replacing the long draft with `Short again.` returns the viewport to one line. |
| [Send reset](685968d3-screenshots-round3/e-send-reset.png) | No — empty | 40 pt | Send clears the draft and restores the baseline `Reply…` state. |
| [Eight lines, caret end](685968d3-screenshots-round3/f-eight-lines-caret-end.png) | Yes — seven | 120 pt | Lines C–H are visible and the caret is visible after `caret end`. |
| [Eight lines, earlier text](685968d3-screenshots-round3/g-eight-lines-scrolled-earlier.png) | Yes — seven | 120 pt | A downward swipe exposes lines A–F, proving manual access to earlier text. |
| [Keyboard dismissed](685968d3-screenshots-round3/h-keyboard-dismissed-collapsed.png) | Yes — seven | 40 pt | The keyboard is gone, the eight-line draft remains, and the viewport collapses to baseline with earlier text still visible. |
| [Immediate refocus](685968d3-screenshots-round3/i-refocus-regrown-caret-end.png) | Yes — seven | 120 pt | One tap immediately restores the capped height; the insertion caret and final line are visible for continued typing. |
| [Refocus, earlier text](685968d3-screenshots-round3/j-refocus-scrolled-earlier.png) | Yes — seven | 120 pt | A downward swipe after refocus exposes lines A–F, proving restored scrolling remains usable. |

All eleven fresh screenshots were inspected at full size. The 80 → 120 → 40 → 120 point sequence directly covers soft-wrap growth, cap, delete/send shrink, keyboard-dismiss collapse, and immediate refocus regrowth against the final refocus implementation. The caret-end and earlier-text pairs are visibly different for both the zero-newline overflow and the eight-line/refocus states.

Final checks after reverting every verification-only source change:

```text
pnpm --dir apps/mobile test -- src/screens/taskComposerInput.test.ts src/screens/TaskScreen.test.tsx src/screens/TaskScreen.attachment.test.tsx src/screens/TaskScreen.composerIsolation.test.tsx src/screens/TaskScreen.agentComposerIsolation.test.tsx
5 files passed; 107 tests passed

pnpm --dir apps/mobile run typecheck
passed

pnpm --dir apps/mobile test
131 files passed, 2 skipped; 1,741 tests passed, 2 skipped

./kd test all
passed; Turbo 17/17 lanes, canonical Rust tests, and canonical local verification all passed. The previously reported tools/kd temporary-directory ENOTEMPTY did not recur; tools/kd/tests/cli.test.ts passed all 30 tests.
```

## Revision round 3: refocus callback ordering

The refocus-then-delete path was verified on 2026-08-24 from the production composer source committed at `4e553af844a165921b284603af5c5853904ba1ba`. The self-contained `Release` bundle was built with Xcode 26.6 for the iPhone 17 Pro simulator `C48044E2-D11B-4A50-993D-D571CA8462E7` on iOS 26.5. Its embedded `main.jsbundle` was built at `2026-08-24T13:29:55+0900` and was 5,915,455 bytes; the app ran with `DEV=false` and no Metro-loaded JavaScript.

The bundle used a temporary direct task fixture, editability override, and title-button blur/keyboard-dismiss hook so XCUITest could establish a real blur/refocus boundary without a live task session. Those verification-only changes were reverted before the final checks and commit. They did not alter the composer measurement, focus expansion, deferred callback guard, scrolling, or viewport sizing code; the production composer source in the bundle is exact to `4e553af84`.

| Screenshot | Explicit newlines? | Viewport height | Inspection |
|---|---:|---:|---|
| [Zero-newline overflow before blur](../../.kanna/kd-state/visual-verification/685968d3-round4/a-overflow-before-refocus.png) | No | 120 pt | The run-on sentence wraps past five visual lines, remains capped, and shows its final text and caret through internal scrolling. |
| [Immediate refocus](../../.kanna/kd-state/visual-verification/685968d3-round4/b-refocused-capped.png) | No | 120 pt | After a real blur collapsed the retained draft to 40 points, refocusing immediately restored the capped viewport with the keyboard, final text, and caret visible. |
| [Delete below cap after refocus](../../.kanna/kd-state/visual-verification/685968d3-round4/c-refocus-delete-shrunk.png) | No | 40 pt | Replacing the refocused overflow with `Short zero newline draft.` visibly shrank the viewport to baseline while focus and the software keyboard remained active. The focused callback-order regression independently asserts that scrolling changes from enabled to disabled at this under-cap measurement. |

All three screenshots were inspected at full size. The measured native sequence was 120 pt capped → 40 pt blurred → 120 pt refocused → 40 pt after deletion. Both the long and short drafts contained zero literal newline characters, so this evidence exercises native soft wrapping rather than the explicit-newline fallback.

Final checks after reverting every verification-only source change:

```text
pnpm --dir apps/mobile test -- src/screens/taskComposerInput.test.ts src/screens/TaskScreen.test.tsx src/screens/TaskScreen.attachment.test.tsx src/screens/TaskScreen.composerIsolation.test.tsx src/screens/TaskScreen.agentComposerIsolation.test.tsx
5 files passed; 107 tests passed

pnpm --dir apps/mobile run typecheck
passed

pnpm --dir apps/mobile test
131 files passed, 2 skipped; 1,741 tests passed, 2 skipped

./kd test all
passed; Turbo 17/17 lanes, desktop production build, canonical Rust tests, and canonical local verification all passed. The reviewer-observed `No space left on device` failure did not recur.
```

This revision remains JS-only. `apps/mobile/src/mobileEnvironments.json` is unchanged at runtime version `2.2.2` for every environment. The owner’s merge-before-device-test override remains unchanged in the task spec.
