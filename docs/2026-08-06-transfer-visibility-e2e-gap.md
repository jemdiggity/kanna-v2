# Cross-machine transfer visibility E2E coverage gap

2026-08-06. Written alongside making transfers visible: a sidebar indicator for
a task with an in-flight or failed `transfer_status`, and an import summary
printed into a transferred task's destination terminal before its agent starts.

## What the E2E asserts

`apps/desktop/tests/e2e/mock/transfer-visibility.test.ts` is written and
committed. It covers the two boundaries that unit tests can only mock:

- **Server snapshot → store → sidebar.** It seeds a `pipeline_item` plus a
  `task_transfer` row for each case — outgoing `streaming`, incoming
  `importing`, outgoing `failed`, incoming `completed` — reloads the snapshot,
  and reads the rendered rows. A task's transfer state is not a column on the
  task; the snapshot derives it by joining the newest relevant transfer, so
  seeding both rows is what makes this exercise the real path. It asserts the
  transferring indicator appears for both directions, the failed state is
  distinguishable by more than colour (different glyph, different tooltip), and
  a completed transfer carries no indicator at all.
- **Store → server spawn → daemon PTY → terminal buffer.** It creates a task
  through `store.createItem` with the same `transferImport` option that
  `approveIncomingTransfer` passes on the receiving machine, selects it, and
  reads the xterm buffer. It asserts the summary lines (source machine, repo
  acquisition mode, whether session history was restored) are present and land
  before the setup banner.

## Why it cannot execute

**The desktop E2E harness cannot bring the app's webview up on this machine.**
`tests/e2e/run.ts` fails in `waitForApp` after its ten-minute wait, so no test
body runs:

    Error: timed out waiting for app at http://127.0.0.1:60183
        at waitForApp (tests/e2e/run.ts:275:9)
        at async startInstances (tests/e2e/run.ts:582:5)

Everything the harness starts is healthy. The dev log shows vite serving, the
app binary launching, and the Rust side fully wired:

    VITE v6.4.2  ready in 222 ms
    ➜  Local:   http://localhost:60182/
    Finished `dev` profile ... in 11.17s
    Running `.build/debug/kanna-desktop`
    [daemon] spawned and connected (pid=13566)
    [event-bridge] connected and subscribed to daemon events

The webview simply never navigates. Over WebDriver the app reports a single
window handle `main` whose URL is `about:blank`, with `window.__KANNA_E2E__`
absent — so `canConnectToApp`'s readiness probe can never pass. Driving that
same session to the dev URL by hand loads the UI normally (`document.title`
becomes `Kanna` and the hook appears), which places the fault before any
application JavaScript runs and therefore outside anything this change touches:
nothing here goes near window creation, the dev URL, or app bootstrap.

The first harness run of the session — before any app instance from this
worktree had been started and stopped — did bring the app up and execute test
bodies. Every run afterwards failed identically.

Four candidate explanations were tested and eliminated:

- **Leaked dev instances wedging the machine.** All were cleared; the next run
  failed identically, from a verified-clean process table.
- **vite binding IPv6-only while the webview loads `http://localhost:port`.**
  Forcing an IPv4 bind (`NODE_OPTIONS=--dns-result-order=ipv4first`, confirmed
  with `lsof` as `TCP 127.0.0.1:63530 (LISTEN)`) changed nothing. Separately
  confirmed from the other side: vite patched to `127.0.0.1` produced the same
  `about:blank` with zero inbound connections recorded, meaning the webview
  never attempts the load at all.
- **A cold-versus-warm build race**, on the theory that the one successful run
  had a two-minute compile that let vite settle first. A forced rebuild
  reproduced the failure.
- **An occluded window deferring WKWebView's load.** Activating the process
  frontmost changed nothing.

Note one trap for anyone retrying this: `TAURI_DEV_HOST=127.0.0.1` does bind
vite on IPv4, but it also switches vite's HMR to `port + 1`, which is the
webdriver port `kd` derives — the app then panics on startup with
`Failed to bind to address: Os { code: 48, kind: AddrInUse }`.

The harness fault is machine-level and is now owned by its own task; it is not
specific to this feature, and any E2E target on this machine is equally blocked.

## What would make it executable

Nothing in the product. Running the existing test on a machine or CI runner
where the harness brings the webview up is sufficient — the test needs no
harness capability that does not already exist, and `run.ts` already holds a
WebDriver session at the point where it gives up, so a harness-side remedy
(navigating a window still sitting at `about:blank` to the configured dev URL
before declaring a timeout) is available if the root cause proves
environmental rather than fixable. That call belongs to the harness task, not
this one.

## Coverage added meanwhile

The behaviour is covered on both sides of the untested boundary:

- `crates/kanna-server/src/task_creator/tests/core.rs` — a create request
  carrying a transfer import summary produces a PTY command containing the
  banner, its source machine, its rendered repo acquisition mode and its
  session-history line, all positioned before the agent invocation; a request
  without one produces no banner.
- `crates/kanna-server/src/db/tests.rs` — the snapshot reports a `failed`
  transfer (it previously reported only in-flight ones, which made the failed
  state unrepresentable in the UI), and a transfer still in flight outranks an
  older failure so a live retry is what the sidebar shows.
- `apps/desktop/src/components/__tests__/Sidebar.test.ts` — rows for outgoing
  and incoming in-flight transfers both carry the transferring state, a failed
  transfer carries the failed state with a different marker, completed and
  never-transferred tasks carry neither, and tooltips name the state.
- `apps/desktop/src/stores/transferImportSummary.test.ts` — the summary names
  the source machine from the peer registry, reports whether session history
  was restored, and degrades to the peer id when the registry is unreachable or
  has forgotten the peer.

What none of these prove is the wiring between them: that the snapshot field
actually reaches the rendered row, and that the composed spawn command actually
reaches the destination terminal. That is exactly what the unexecuted E2E is
for.
