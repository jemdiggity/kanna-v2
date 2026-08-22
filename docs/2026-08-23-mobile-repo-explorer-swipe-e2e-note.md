# Mobile repo explorer swipe navigation E2E note

The repository explorer gained edge-only, interactive back/forward swipes on
2026-08-23. A left-edge rightward drag backs out of a file or directory, and a
right-edge leftward drag re-enters the last backed-out location. The edge gate
is essential: horizontal gestures starting in the WebView body must remain
file scrolling, while vertical gestures remain FlatList scrolling and
pull-to-refresh.

## Why physical gesture coverage did not run

The mobile component test can drive the responder configuration, but it cannot
reproduce iOS WebView and FlatList responder negotiation. The physical journey
requires a compatible installed Expo development client plus Appium/XCUITest;
that device setup is not available in this task. Gesture feel and native
responder coexistence therefore remain a manual-device verification.

## Narrower coverage

- `src/screens/repoExplorerState.test.ts` covers file/directory back and
  forward order, root behavior, and browser-style forward truncation after new
  navigation.
- `src/screens/RepoExplorer.component.test.tsx` proves the header Back button
  populates forward history, a right-edge swipe consumes it, and mid-screen or
  vertically dominant drags are not claimed.

A device E2E becomes practical when the standard mobile development client and
Appium fixture are available. It should open a long horizontally scrollable
file, assert a mid-screen drag scrolls the WebView without navigating, then
exercise both edges and repeat the vertical case on a refreshable directory.
