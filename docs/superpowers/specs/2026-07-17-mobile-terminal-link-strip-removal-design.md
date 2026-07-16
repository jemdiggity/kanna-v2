# Mobile Terminal Link Strip Removal

## Goal

Remove the floating list of recently detected file links from the mobile terminal while preserving file paths as directly tappable xterm links. Defer changes to task-file fetching and preview behavior until the backend deployment is confirmed.

## Design

The generated terminal document will keep its row-scoped xterm link provider, file-path parser, gesture guard, and `terminal-file-link` activation message. It will stop scanning recent scrollback, rendering fallback link buttons, and emitting `terminal-file-links` discovery messages.

`TerminalWebView` will remove the discovered-link state, `terminal-file-links` message handling, native `ScrollView`/button strip, and strip-only styles and imports. Its existing `terminal-file-link` handler will continue forwarding tapped paths to `TaskScreen`, so the preview flow remains otherwise unchanged.

No server, transport, file-preview, or desktop behavior changes are included.

Removing the separate buttons also removes their VoiceOver nodes. This change deliberately leaves direct xterm hit-testing as the only file-link activation path; a future accessibility affordance must be non-floating and should not restore a recent-files list.

## Testing

- Assert that the generated document contains no floating file-link region and emits no discovery-list message after terminal output changes.
- Retain coverage that xterm detects file paths with correct ranges and sends `terminal-file-link` when an xterm link is activated.
- Assert that `TerminalWebView` contains no native file strip while continuing to forward direct file-link activation messages.
- Replace the relay Appium journey that pressed the removed native buttons with coverage that emitted paths remain in xterm and no separate native file-link controls appear. Direct xterm activation remains unit-tested because the installed iOS WebView does not expose xterm link hitboxes to Appium.
- Run the focused mobile screen tests and mobile typecheck.
