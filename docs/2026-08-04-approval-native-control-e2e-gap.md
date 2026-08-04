# Approval native-control E2E gap (2026-08-04)

The real interaction test in
`apps/desktop/tests/e2e/real/approval-native-control.test.ts` now selects a
durable merge-agent task, types into its actual xterm textarea, and requires the
bytes to echo from an operator-protected real daemon PTY. The assertion is not
mocked or waived.

On 2026-08-04 the clean command

```text
NODE_OPTIONS=--dns-result-order=ipv4first pnpm --dir apps/desktop test:e2e -- real/approval-native-control.test.ts
```

did not reach the test. It exhausted the runner's configured ten-minute app
readiness timeout. During the full wait:

- `tauri-plugin-webdriver` returned a healthy `/status` response on the
  assigned port;
- Vite listened on the assigned IPv4 port and the desktop, daemon, and server
  processes all remained live;
- a diagnostic WebDriver session reported `location.href === "about:blank"`,
  `document.readyState === "complete"`, and `window.__KANNA_E2E__ === null`;
- no worktree webview log was created, so the frontend safety gate never ran.

This is a runner/WebDriver attachment failure before application JavaScript,
not a pass or failure of the native-control flow. The lane becomes exercisable
when `tauri-plugin-webdriver` attaches its session to the loaded Tauri main
webview (or the runner can explicitly select that webview) instead of an empty
`about:blank` browsing context.

Narrower coverage retained meanwhile:

- a real daemon integration rejects generic `Input` and `InputNoReply` for a
  protected PTY, rejects unauthenticated policy classification, and accepts
  process-authenticated `OperatorInput`;
- desktop unit tests prove merge-history task detail selects
  `send_operator_input` while ordinary terminals retain KSP input;
- the real E2E test remains checked in and must pass once the attachment issue
  is resolved.
