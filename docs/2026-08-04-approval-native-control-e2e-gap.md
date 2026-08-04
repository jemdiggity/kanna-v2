# Approval native-control E2E note (2026-08-04)

The real interaction test in
`apps/desktop/tests/e2e/real/approval-native-control.test.ts` now selects a
durable merge-agent task, types into its actual xterm textarea, and requires the
bytes to echo from an operator-protected real daemon PTY. The assertion is not
mocked or waived.

An initial 2026-08-04 run of the clean command

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

That run was a runner/WebDriver attachment failure before application
JavaScript, not a pass or failure of the native-control flow. A later clean run
did attach to the Tauri main webview and reached the real interaction. It
exposed a test race: task detail switched the terminal from ordinary to
protected input and remounted it while WebDriver was typing into the stale
textarea. The test now waits for the protected operator-input terminal before
typing.

The next clean run against that correction was allowed to reach the complete
configured ten-minute readiness timeout. Vite, the desktop, server, daemon,
event bridge, and WebDriver status endpoint were live. After the timeout, a
new WebDriver session reported `location.href === "about:blank"`,
`document.readyState === "complete"`, `window.__KANNA_E2E__ === null`, and an
empty body. No new worktree webview log existed, so the frontend safety gate
never executed. The corrected real xterm assertion remains mandatory and is
not waived; this lane is infrastructure-blocked until WebDriver consistently
attaches to the Tauri main webview.

The cross-boundary coverage is backed by narrower regressions:

- a real daemon integration rejects generic `Input` and `InputNoReply` for a
  protected PTY, rejects unauthenticated policy classification, and accepts
  process-authenticated `OperatorInput`;
- desktop unit tests prove merge-history task detail selects
  `send_operator_input` while ordinary terminals retain KSP input;
- desktop transport tests fault-inject lost and slow acknowledgements to prove
  operator bytes are delivered at most once and timed-out streams are retired.
