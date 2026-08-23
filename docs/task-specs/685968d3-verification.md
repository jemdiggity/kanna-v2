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

Final checks after reverting the E2E-only editability override:

```text
pnpm --dir apps/mobile test -- src/screens/taskComposerInput.test.ts src/screens/TaskScreen.test.tsx src/screens/TaskScreen.attachment.test.tsx src/screens/TaskScreen.composerIsolation.test.tsx src/screens/TaskScreen.agentComposerIsolation.test.tsx
5 files passed; 106 tests passed

pnpm --dir apps/mobile run typecheck
passed

pnpm --dir apps/mobile test
131 files passed, 2 skipped; 1,740 tests passed, 2 skipped
```

This is a JS-only change. All three values in `apps/mobile/src/mobileEnvironments.json` remain at runtime version `2.2.2`.
