# Mobile Search Focus Appium Coverage

**Date:** 2026-07-17
**Status:** Approved design

## Goal

Exercise the real iOS simulator journey behind the mobile Search toolbar action: tap the magnifying-glass control, observe the Search screen, and prove the native **Search tasks** input receives focus and opens the software keyboard. Repeat the action after dismissing the keyboard while Search remains open to prove every Search tap can refocus the existing input.

## Architecture

Add stable React Native `testID` values at the native boundaries used by Appium: the toolbar Search `Pressable`, the Search screen root, the Search `TextInput`, and the Search heading used as an outside-input keyboard-dismissal target. Expose those identifiers through the existing shared E2E selector module so the journey does not depend on visible text or view hierarchy.

Keep the journey in a dedicated `search-focus.e2e.ts` smoke module. Its driver adapter compares the Search input with WebDriver's active element, checks Appium keyboard visibility, and polls through the existing `waitUntil` pattern. Keyboard dismissal uses a real tap on the Search heading; this matches the user interaction and avoids relying on Appium's deprecated generic `hideKeyboard` endpoint. The exported helper accepts a small UI interface so Vitest can verify the journey's ordering and repeated-tap contract without mocking the production React components.

The standard `smoke` mode will run the journey after the list/detail/back flow and before the profile flow. A standalone `search-focus` mode runs the same native journey without requiring the unrelated live-PTY fixture used by the aggregate smoke. After verifying the second focus, the journey dismisses the keyboard and returns to Tasks so existing smoke modules keep their current preconditions.

## Native Assertions

The first Search tap must make the Search screen and Search input exist, report the input as WebDriver's native active element, and report the software keyboard as visible. Tapping the Search heading must produce both keyboard-hidden and input-not-active states while the Search screen remains displayed before the second toolbar tap. The second tap must restore both native active-element focus and keyboard visibility without remounting or leaving Search first.

The active-element response is normalized across W3C and legacy WebDriver element-reference keys. This is more precise for keyboard focus than XCUITest's generic `focused` attribute, which reports XCTest `hasFocus` and remained false for the focused React Native text input during simulator validation.

## Files

- `apps/mobile/src/e2eTestIds.ts`: stable Search control identifiers.
- `apps/mobile/src/e2eTestIds.test.ts`: identifier contract coverage.
- `apps/mobile/src/components/FloatingToolbar.tsx`: Search utility action identifier.
- `apps/mobile/src/screens/SearchScreen.tsx`: screen, native input, and keyboard-dismissal identifiers.
- `apps/mobile/e2e/helpers/selectors.ts`: Appium selector mapping.
- `apps/mobile/e2e/helpers/selectors.test.ts`: selector contract coverage.
- `apps/mobile/e2e/specs/smoke/search-focus.e2e.ts`: real driver adapter and reusable journey.
- `apps/mobile/e2e/specs/smoke/search-focus.test.ts`: helper-level journey coverage.
- `apps/mobile/e2e/run.ts`: aggregate and standalone smoke registration/execution wiring.
- `apps/mobile/e2e/run.test.ts`: smoke manifest coverage.
- `apps/mobile/package.json`: standalone Search-focus simulator command.

## Verification

Run focused Vitest coverage first, then the required repository and daemon suites. Run simulator preflight followed by the standalone `test:e2e:search-focus` journey when its installed dev client, Appium/XCUITest driver, desktop server, and Metro environment are available. The aggregate smoke additionally requires known PTY fixture variables. If simulator execution is unavailable, report the exact failed preflight or missing prerequisite and retain the helper tests, selector contracts, component tests, typecheck, and required suites as narrower automated evidence.

## Out of Scope

- Changing the existing request-key focus behavior.
- Adding platform-specific production keyboard code.
- Running physical-device automation.
- Changing search queries, results, or navigation semantics.
