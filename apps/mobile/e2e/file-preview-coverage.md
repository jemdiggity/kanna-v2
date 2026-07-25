# Mobile File Preview E2E Coverage

`pnpm --dir apps/mobile run test:e2e:relay` owns the cross-boundary file-preview
coverage because this journey crosses the terminal WebView, React Native,
relay transport, owner server, SQLite task/worktree lookup, and the owner's
filesystem. The relay fixture emits a Markdown path, a unique nested file by
bare filename and line number, and an ambiguous bare filename with two owner
filesystem matches.

Appium waits for those mentions in xterm, asserts that the removed horizontal
file strip is absent, then drives `+ -> Mentioned Files`. It verifies the
dynamic count and the canonical rows returned by owner-side unique and
ambiguous resolution. Selecting the unique bare mention opens the raw preview
at the requested line; reopening the menu and selecting the Markdown row opens
the rendered preview.

Native inspection metadata is required proof for both selections. It reports
the canonical path, preview mode, initial line, and authenticated file content,
so the journey still verifies relay routing, owner-side resolution, and file
reads when Appium cannot expose a preview `WEBVIEW_*` context. When a WebView
context is available, the lane additionally requires the raw `.raw-line`
overlay to target and flash the requested line with nonzero layout, and
requires rendered Markdown to contain a laid-out Highlight.js token whose
computed color differs from its code block. Those live-document assertions are
conditionally skipped only when preview WebView inspection is unavailable.
Direct xterm hitbox activation remains unit-tested because Appium does not
reliably expose xterm link coordinates.

## Local execution limitation

The canonical lane was rerun on July 25, 2026 after
`./kd dev up --mobile --emulators`, using the rebuilt development app on iOS
Simulator 26.2, Appium 2.19.0, and XCUITest driver 9.9.1. The file-preview
portion ran successfully through its required native assertions: Appium opened
`Mentioned Files (3)`, displayed the owner-resolved unique and ambiguous rows,
resolved the unique bare mention to `fixtures/unique/TaskScreen.tsx`, fetched
authenticated file content through the relay, and exposed the expected native
inspection metadata for both the raw line-linked preview and the rendered
`docs/spec.md` preview. The lane continued beyond file preview and eventually
exited 1 in the visual-companion journey.

The exact remaining blocker is WebKit inspection in this simulator/tooling
combination. Appium advertised `WEBVIEW_*` contexts for `about:blank` pages, but
each JavaScript evaluation returned `-32601: 'Runtime' domain was not found`.
Consequently the later visual-companion assertion received an empty document
instead of `Initial relay visual companion`. A fully green lane needs an
Appium/XCUITest/WebDriverAgent and iOS simulator-runtime combination whose
WebKit remote inspector exposes an executable JavaScript `Runtime` domain, or a
compatible driver/runtime update that correctly classifies those contexts as
unavailable. It also needs the current dev client plus the Kanna-assigned
Metro, Appium, emulator, relay, and mobile-server ports; the canonical `kd`
command supplies those services.

## Deterministic coverage while the lane is blocked

- `e2e/specs/relay/relay-task-flow.test.ts` verifies `+ -> Mentioned Files`
  orchestration, dynamic menu counts, canonical unique/ambiguous rows, preview
  selection order, WebView context selection, unavailable-context handling,
  and native-context restoration.
- `e2e/helpers/relay-harness.test.ts` fixes the unique bare mention, ambiguous
  owner-side matches, Markdown code fence, Highlight.js token, and line-linked
  raw target used by the real relay journey.
- `src/screens/buildTerminalDocument.test.ts`,
  `src/screens/TerminalWebView.test.tsx`,
  `src/screens/TaskMentionedFiles.test.tsx`, and
  `src/screens/TaskScreen.test.tsx` verify bounded mention history, the bridge,
  native list states, resolution, and canonical preview wiring.
- `src/screens/buildTaskFilePreviewDocument.test.ts` verifies the generated
  preview runtime marks the actual computed line-flash animation after applying
  the overlay.
- `src/screens/TaskFilePreview.test.tsx` keeps the React Native loading and
  preview document wiring covered.
- `cargo test -p kanna-server task_file` verifies authenticated route mapping,
  exact/bare/ambiguous owner resolution, ignore and containment rules, bounded
  traversal, and the async blocking boundary.

These tests keep each layer and the fixture/inspection contract deterministic,
but they do not replace a successful Appium run. The relay lane remains the
required cross-boundary proof.
