# Claude Code TUI frame

`idle-composer-2.1.259-280x81.json` is the serialized terminal snapshot from
the reported staging incident, task `34ab8c46`, at the daemon handoff on
2026-09-03 13:59:54 UTC. It was extracted without alteration from
`kanna-daemon_37964_2026-09-03_07-59-53.log` after scoping the live connection
to Kanna Staging on desktop `desktop-aa43ab36`.

The installed Claude executable had been version 2.1.259 since 2026-09-02
22:49:36 UTC, before this session started. The captured frame is visibly idle:
it ends with the turn's `done` line, an empty `❯` composer, a divider, and the
`bypass permissions` status bar. The handoff metadata nevertheless carried
`inheritedStatus: "busy"`; preserving both the raw VT snapshot and that verdict
lets the tests pin the classifier bug and the restart/re-adoption bug together.

The `snapshot` object is directly deserializable as the daemon protocol's
`TerminalSnapshot` and is replayed through `HeadlessTerminal`, not normalized
or transcribed into an assumed screen shape.

## 2.1.263 working footer and status bar

`working-footer-2.1.263-171x65.json`,
`working-footer-first-paint-2.1.263-171x65.json` and
`parked-composer-status-bar-2.1.263-171x65.json` are three frames of one live
`claude --permission-mode bypassPermissions` PTY, run at 171x65 on desktop
`desktop-aa43ab36` on 2026-09-06 and recorded raw. `serialized` is the
unaltered VT stream up to that instant; the tests replay it through
`HeadlessTerminal` rather than transcribing an assumed screen shape.

They pin what 2.1.263 actually draws, which is what
`docs/2026-09-06-claude-2.1.263-status-latch.md` reports:

- **No `esc to interrupt`, anywhere.** The hint every earlier CLI drew in its
  working footer is gone, so `INTERRUPT_MARKER` matches nothing on a Claude
  frame and the in-flight footer is the only positive busy signal left.
- **The composer is drawn while the turn is in flight.** Both working frames
  carry an empty `❯` above the status bar, so a composer alone cannot prove a
  session settled — only the footer row differs between working and parked.
- **The status bar below the composer carries unmeasured rows** — `/rc`,
  `● high · /effort`, a login-expiry notice — which is why the parked frame is
  classified from the composer box's closing divider rather than from an
  enumeration of the rows beneath it.

`working-footer-first-paint` is the first paint of a turn: the footer is
`· Tomfoolering…`, drawn with the dim `·` glyph and before the elapsed timer
appears, which is why `CLAUDE_WORKING_FOOTER_GLYPH` exists alongside
`line_is_claude_spinner`'s star glyphs.
