# Mobile OTA Information Removal Design

## Goal

Remove OTA implementation details from the mobile app's More screen without changing how the app checks for, downloads, or applies OTA updates.

## Design

The More screen will contain only its command palette and active-task context. The entire “App update” diagnostics card—including the enabled state, channel, runtime version, and update identifier—will be removed.

OTA behavior remains unchanged: the app checks in the background, downloads available updates, and shows the existing “Update ready” banner with dismiss and restart actions. Configuration and update-client tests remain the source of truth for whether OTA is enabled in each environment.

The UI-only metadata path will be deleted end to end: the More-screen prop and row formatter, the current-update-info helper and state in `App`, and the E2E selector/smoke assertion that reads the diagnostic card. A component regression test will assert that the More screen does not render the card or its values.

## Verification

- Run the new More-screen component test through a red-green cycle.
- Run the mobile unit suite and TypeScript typecheck.
- Confirm the existing OTA lifecycle and update-ready-banner tests still pass.
