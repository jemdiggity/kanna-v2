# Terminal Streaming E2E Coverage

`pnpm --dir apps/mobile run test:e2e:smoke` exercises the PTY terminal path in
`specs/smoke/list-detail-back.e2e.ts`. After opening the first task, the smoke
checks that Appium can switch into the WebView, that decoded terminal bytes
reached the xterm write path without being blank or corrupt, and that the
terminal root received the desktop PTY dimensions through `data-kanna-cols` and
`data-kanna-rows`.

This is only testable end to end when the mobile dev stack is running with
`./kd dev up --mobile` and the shell has the generated E2E environment, including
`KANNA_E2E_DESKTOP_SERVER_URL`, `KANNA_APPIUM_PORT`, and an installed simulator
or device build. Without that environment, Appium cannot open the app or inspect
the WebView.

The simulator-free coverage is:

- `src/screens/TerminalWebView.test.tsx` for pending resize-before-snapshot
  script ordering.
- `src/screens/buildTerminalDocument.test.ts` for large newline-delimited
  base64 frame preservation and the resize bridge.
- `e2e/specs/smoke/list-detail-back.test.ts` for Appium WebView context
  switching, rendered terminal inspection, and the explicit failure message when
  WebView inspection is unavailable.
