# Mobile Build Identity Surface Design

## Goal

Give mobile operators an unobtrusive, readily accessible way to identify the exact native build and JavaScript bundle running on a device while validating OTA updates.

## Placement and Interaction

The More screen will render a compact `About this build` row after its repository-command content. The collapsed row shows the installed native application version and build number, for example `2.4.0 (108)`, with a disclosure chevron.

Pressing the row expands build details in place. The expanded panel shows:

- Native: the installed native application version and build number.
- Runtime: the Expo Updates runtime version.
- Environment: the Kanna application environment (`dev`, `staging`, or `prod`).
- Channel: the configured OTA channel (`staging`, `production`, or `None`).
- Running source: the full current Expo update UUID, `Embedded bundle`, or `Development bundle (Metro)`.

The OTA update UUID must not be shortened. Pressing the UUID copies the exact value through the existing `expo-clipboard` dependency and temporarily changes the adjacent hint to `Copied`.

The panel remains collapsed by default so repository commands retain visual priority. It uses the existing More-screen colors, typography, borders, and spacing rather than introducing a new presentation system.

## Architecture

Create a focused build-identity adapter that reads the native Expo APIs and returns a plain presentation model. Create a small build-information component that owns expansion and copy-feedback state. `MoreScreen` only places the component after its command sections, keeping repository command behavior independent of native diagnostics.

The adapter uses:

- `expo-application` for `nativeApplicationVersion` and `nativeBuildVersion`, which reflect the installed binary rather than OTA manifest metadata.
- `expo-updates` for `isEnabled`, `isEmbeddedLaunch`, `updateId`, `runtimeVersion`, and `channel`.
- Kanna Expo extra configuration for `appEnv` and the environment registry fallback for configured runtime/channel values when Expo Updates is disabled in development.

The adapter accepts injectable input values so its classification and fallback behavior can be unit-tested without loading native modules. A default reader performs the real module imports for application use.

Adding `expo-application` is a native dependency change. Following the repository mobile runtime policy, every environment in `apps/mobile/src/mobileEnvironments.json` will move from runtime version `2.1.1` to `2.1.2`, and the existing Expo configuration assertions will be updated with it.

## Source Classification and Fallbacks

The running source is classified in this order:

1. When Expo Updates is disabled, display `Development bundle (Metro)`. Development builds intentionally do not configure OTA updates.
2. When Expo Updates reports an embedded launch, display `Embedded bundle`, even if the module exposes an identifier for the embedded update.
3. Otherwise, when an update ID is present, display the full ID as the currently running OTA update.
4. If Updates is enabled but neither an embedded launch nor an update ID can be identified, display `Unknown`.

Missing native version, native build, or runtime values display `Unknown`. A missing channel displays `None`. These fallbacks are rendered locally and never prevent the More screen or its repository commands from loading.

The collapsed native summary uses `version (build)` when both values exist, the available value when only one exists, and `Unknown` when neither exists.

## Testing

Focused automated coverage will include:

- Build-identity adapter tests for OTA, embedded, development/Metro, and missing-value classification.
- Component tests for collapsed-by-default rendering, expansion, the full untruncated update ID, clipboard invocation, and transient `Copied` feedback.
- A More-screen component test proving the build-information surface is present without changing repository command behavior.
- Existing mobile app-configuration tests updated to lock all environments to runtime version `2.1.2`.

Verification will run the focused Vitest files, the mobile TypeScript check, relevant configuration tests, and `git diff --check`. The work does not publish an OTA update and does not install or launch a physical device build.

## Documentation

Update `apps/mobile/README.md` with the More-screen location and the interpretation of OTA update IDs, embedded bundles, and Metro development bundles. The documentation will also retain the existing rule that adding a native dependency requires a runtime version bump.
