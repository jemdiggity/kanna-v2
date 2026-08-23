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
