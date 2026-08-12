# Remote terminal warm-cache and clipboard E2E gap (2026-08-12)

## Blocker

The release-line two-instance test in
`apps/desktop/tests/e2e/real/cloud-task-sync.test.ts` now contains the intended
real interaction journey: it keeps two relay terminals live, switches between
them, types through the focused xterm, verifies inactive output and xterm
identity/size retention, resizes the window before reactivation, selects remote
output through `terminalBuffers.selectText`, sends macOS Command+C, and reads
the OS clipboard with `/usr/bin/pbpaste`.

The current harness cannot reach that journey. On 2026-08-12, running
`pnpm --dir apps/desktop test:e2e -- real/cloud-task-sync.test.ts` failed in
both existing cloud-terminal tests before the new assertions. After
`handleSelectItem` was called with the synchronized cloud item, diagnostics
showed `mainPanelIsCloudTask=false`, `mainPanelCloudTerminalRef=null`, and a
selected local creation draft (`selectedItemId=create:*`). The only registered
terminal belonged to the locally launched task, so the original waits for
`Cloud terminal ready from primary` and `Relay stream attach marker` timed out.
This happens before `CloudTerminalView` for the remote task mounts and is not a
failure of the new focus, clipboard, cache, resize, or reconnect assertions.

## Enabling condition

The real journey becomes runnable when the two-instance cloud-sync fixture can
deterministically select the remote projection after `store.createItem` starts
the owning task. In particular, `handleSelectItem(cloudItemId)` must leave the
secondary with `mainPanelIsCloudTask=true`, a non-null cloud terminal ref, and
the remote task's xterm buffer rather than a local `create:*` draft. Once that
baseline selection race/regression is repaired, the committed journey exercises
the OS clipboard and warm-cache behavior without further test-only transport
mocking.

## Narrower coverage

- `CloudTerminalView.remoteInput.test.ts` mounts the real cache and terminal
  components with controlled transport clients. It proves inactive output
  continues, the cached xterm and connection are reused, reactivation resizes
  and focuses it, and keyboard data goes only to the selected task.
- The same focused suite drives inactive Exit, reactivation of a replacement
  same-ID session, and resumed input/output through the replacement client.
- `e2eTerminalBuffers.test.ts` proves `selectText` selects the requested xterm
  output; the existing Command+C component tests prove selected text is copied
  while empty-selection Command+C falls through to xterm.
- Task-transfer boundary tests send more than 4 KiB through protocol v2, prove
  FIFO chunk reconstruction, and prove the observer stream remains usable.
