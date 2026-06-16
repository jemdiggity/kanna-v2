# Mobile ConnectionScreen E2E Gap

The password visibility control is covered end to end on the currently mounted
mobile sign-in surface: the account sheet opened from the app top bar. The
Appium profile connection smoke helper opens that sheet, verifies the profile
connection controls, and drives the password toggle through Show, Hide, and
Show states.

`apps/mobile/src/screens/ConnectionScreen.tsx` has the same user-facing
sign-in controls, but the current mobile app shell does not route to or mount
that screen. `App.tsx` renders the task/navigation shell and exposes sign-in
through `AccountSheet`, so the existing Appium runner cannot exercise
`ConnectionScreen` without adding a dedicated test-only route or changing the
production navigation surface. Until that screen becomes reachable in the app,
its password visibility behavior is covered by
`apps/mobile/src/screens/ConnectionScreen.test.tsx` component tests rather than
mobile E2E.
