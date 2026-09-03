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
