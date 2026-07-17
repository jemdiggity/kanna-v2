# Mobile OTA Information Removal Design

## Goal

Remove OTA implementation details from the mobile app's More screen without changing how the app checks for, downloads, or applies OTA updates.

## Design

The More screen will contain only its command palette and active-task context. The entire “App update” diagnostics card—including the enabled state, channel, runtime version, and update identifier—will be removed.

OTA behavior remains unchanged: the app checks in the background, downloads available updates, and shows the existing “Update ready” banner with dismiss and restart actions. Configuration and update-client tests remain the source of truth for whether OTA is enabled in each environment.

The UI-only metadata path will be deleted end to end: the More-screen prop and row formatter, plus the current-update-info helper and state in `App`. A component regression test will assert that the More screen does not render the card or its values.

The Appium smoke will retain coverage of the user-visible integration boundary. It will navigate from the real floating toolbar to the More route, wait for a dedicated More-screen root marker, and only then assert that the historical `mobile.update-info.ota` element is absent. Waiting for the positive marker prevents the negative assertion from passing before navigation completes.

## Verification

- Run the new More-screen component test through a red-green cycle.
- Run the Appium helper test that covers toolbar navigation, positive route detection, and the absent legacy OTA element.
- Run the mobile unit suite and TypeScript typecheck.
- Confirm the existing OTA lifecycle and update-ready-banner tests still pass.
