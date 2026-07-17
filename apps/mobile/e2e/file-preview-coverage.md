# Mobile File Preview E2E Coverage

`pnpm --dir apps/mobile run test:e2e:relay` owns the cross-boundary file-preview
coverage. The relay fixture emits links for the same Markdown file in rendered
and line-linked raw modes. Appium opens each link, switches from the React
Native app into the preview WebView, and executes an inspection in the live
document. The rendered assertion requires a Highlight.js keyword token with a
computed color different from its containing code block. The raw assertion
requires the runtime-created `.raw-line` overlay to target the requested
`data-line`, have nonzero layout, and report that the flash animation started.
Native inspection metadata is not used as proof of either behavior.

## Local execution limitation

The relay lane was attempted on July 17, 2026 with a freshly rebuilt dev client,
iOS Simulator 26.2, Appium 2.19.0, and XCUITest driver 9.9.1. The Expo deep link
worked: simulator networking logs showed the app fetch
`/apps/mobile/index.bundle` from the task-reserved Metro port 8172, and a
simulator screenshot showed the React Native task shell rendered. WebDriverAgent
nevertheless reported the full-screen `mobile.app-shell` hierarchy as
`visible="false"`. Enabling XCUITest's simple visibility mode moved the run past
the shell, but the same driver then could not expose the React Native account
modal after tapping the visible account control. The run therefore stopped
before the task and preview WebViews were opened.

This is a native automation limitation before the behavior under test, not a
substitute result for the preview assertions. A complete local execution needs
an Appium/WebDriverAgent and simulator-runtime combination that exposes the
rendered React Native controls and the preview `WEBVIEW_*` context. That can be
provided by a compatible XCUITest driver update or by running the lane on a
supported simulator runtime, with the current dev client installed and the
Kanna-assigned Metro and Appium ports available.

## Deterministic coverage while the lane is blocked

- `e2e/specs/relay/relay-task-flow.test.ts` verifies WebView context selection,
  DOM inspection result handling, native-context restoration, token color
  comparison, and raw overlay/flash requirements.
- `e2e/helpers/relay-harness.test.ts` fixes the Markdown code fence, Highlight.js
  token, and line-linked raw target used by the real relay journey.
- `src/screens/buildTaskFilePreviewDocument.test.ts` verifies the generated
  preview runtime marks the actual computed line-flash animation after applying
  the overlay.
- `src/screens/TaskFilePreview.test.tsx` keeps the React Native loading and
  preview document wiring covered.

These tests keep the fixture and inspection contract deterministic, but they do
not replace a successful Appium run. The relay lane remains the required proof
that the token and raw-line overlay exist in the executing mobile WebView.
