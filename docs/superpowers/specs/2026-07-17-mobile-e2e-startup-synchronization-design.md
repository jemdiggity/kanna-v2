# Mobile E2E Startup Synchronization Design

## Goal

Make clean exact-environment simulator launches reliably reach the mobile profile and Machines assertions even when Expo's development menu becomes key only after Metro finishes the cold JavaScript bundle.

## Root cause

The runner opens the Expo development-client URL and performs one short pass over onboarding, dev-menu, and Bonjour prompts. A cold bundle can complete after that pass. Expo then presents its development menu over Kanna, leaving `mobile.app-shell` undisplayed when the profile smoke spec starts.

## Design

Replace the one-shot dismissal helper with a condition-driven readiness helper. During one bounded startup window, each poll will inspect the current native UI, dismiss onboarding or the Expo development menu when present, accept only the recognized Bonjour permission alert, and then check `mobile.app-shell`. Readiness succeeds only when the app shell is displayed.

The loop remains in `apps/mobile/e2e/run.ts` because these overlays and the app-shell boundary are runner startup concerns. It will use WebdriverIO's condition wait rather than a fixed sleep or Metro-output coupling. Metro reporting a completed bundle is not sufficient because Expo may present native UI after that event.

## Error handling

The helper uses a bounded timeout and surfaces a startup-specific timeout message. Optional overlays remain optional; missing elements do not fail a poll. Unexpected system alerts are not accepted, preserving the profile-disconnected test's control over alert handling.

## Testing

Add a narrow runner unit test with a fake driver whose initial poll has neither the app nor the menu, whose later poll exposes the Expo dev menu, and whose app shell becomes displayed only after that menu is dismissed. The test must prove the helper does not return after the early empty state and does dismiss the late overlay before completing.

Then run the focused mobile runner tests, the real `profile-disconnected` simulator E2E, the repository test suite, daemon tests serialized to one thread, and `kanna-server` tests serialized to one thread.
