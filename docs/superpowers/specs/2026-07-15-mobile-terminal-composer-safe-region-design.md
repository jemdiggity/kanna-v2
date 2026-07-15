# Mobile Terminal Composer Safe Region Design

## Goal

Keep PTY terminal content readable when the user browses scrollback behind the
mobile task screen's floating composer. Content must remain above the composer
instead of becoming obscured when sticky-bottom mode turns off.

## Context

The fullscreen mobile terminal already receives a 132 px bottom inset. The
generated terminal document applies that inset to xterm's internal viewport
only while `stickyToBottom` is true. As soon as the user scrolls into history,
the document sets the viewport bottom to zero and allows terminal rows to render
behind the floating composer.

This behavior was intentional in the original task-detail design, but it makes
scrollback harder to read. The outer WebView padding does not solve the problem
because vertical terminal scrolling is owned by xterm's internal viewport.

## Scope

This change applies only to raw PTY tasks rendered by `TerminalWebView`.

- Keep the native agent-message feed unchanged; it already uses React Native
  scroll content padding.
- Keep the floating composer and task action button unchanged.
- Keep the existing 132 px fullscreen inset and 24 px embedded inset.
- Do not change terminal transport, PTY dimensions, input submission, or task
  state.
- Do not add custom nested-scroll or touch-handoff behavior.

## Approaches Considered

### Permanent terminal safe region (selected)

Always end xterm's visible viewport above the configured bottom inset. The
composer continues to float over the terminal background, but it never covers
readable terminal rows.

This is the smallest and most reliable solution. The area is not useful reading
space while covered by the composer, so keeping it clear does not reduce the
amount of content the user can actually read.

### True bottom overscroll

Keep xterm full height and coordinate its internal scroller with an outer
WebView spacer when the user reaches the bottom. This would preserve the current
behind-composer layout until the user pulls farther, but xterm owns touch
scrolling and prevents a natural nested-scroll handoff. Custom gesture routing
would be more fragile and would require more device-specific testing.

### Non-floating composer

Move the composer into normal layout below the terminal. This eliminates the
overlap structurally, but changes the approved terminal-first visual design and
expands the task beyond terminal scroll behavior.

## Design

`buildTerminalDocument` remains the owner of terminal scroll presentation. Its
two concerns will be separated:

1. The configured `bottomInset` always controls xterm's visible bottom edge.
2. `stickyToBottom` only controls whether new output automatically follows the
   live terminal bottom.

When xterm's viewport is discovered, the document applies the configured inset.
Scroll events may update `stickyToBottom`, but they must not remove the inset.
Resize, replace, and append paths continue to reapply the same inset defensively.

The resulting behavior is:

- At the live bottom, the newest terminal rows sit above the composer and new
  output continues to follow automatically.
- After the user scrolls upward, the viewport remains above the composer and
  new output does not move the user's reading position.
- After the user returns to the existing near-bottom threshold, subsequent
  output resumes following the live bottom.
- Horizontal scrolling, pinch zoom, terminal taps, and pinned desktop PTY
  dimensions retain their current behavior.

`TerminalWebView` keeps its existing inset constants and document-building
contract. `TaskScreen` and `AgentMessageView` require no changes.

## Error Handling

The generated document already treats a missing xterm viewport as a temporary
layout state and retries through later fit/sync calls. The safe-region change
keeps that behavior. It introduces no new asynchronous work, bridge messages,
or failure states.

## Testing

Extend `buildTerminalDocument.test.ts` with executable DOM coverage that proves:

- the configured inset is applied after xterm initializes;
- scrolling away from the bottom does not collapse the inset;
- appending output while scrolled up does not call `scrollToBottom`;
- returning to the near-bottom threshold restores sticky following for later
  output;
- existing horizontal scrolling and pinch-zoom tests remain green.

Verification commands:

```bash
pnpm --dir apps/mobile test -- src/screens/buildTerminalDocument.test.ts
pnpm --dir apps/mobile run typecheck
pnpm --dir apps/mobile test
```

This interaction ideally also has device-level coverage. The current Appium
harness cannot reliably expose the terminal WebView context, as documented in
`docs/2026-07-09-remote-e2e-layer-c-d-runbook.md`. The executable generated-DOM
test is the focused regression coverage for this change; final visual/touch
confirmation remains a human simulator or device check.

## Success Criteria

- No PTY terminal row is covered by the floating composer while browsing
  scrollback.
- Manual scrollback remains stable while terminal output continues.
- Returning to the bottom resumes live-output following.
- Native agent-message tasks and terminal touch navigation are unchanged.
