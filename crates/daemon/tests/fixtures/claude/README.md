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
  working footer is gone. The rule that matches it, `claude/busy/interrupt-marker`,
  is therefore version-ranged `<2.1.263`: it still classifies a session on an
  older CLI, and the in-flight footer is the only positive grid signal left for
  2.1.263 (with the animated terminal title beside it — see below).
- **The composer is drawn while the turn is in flight.** Both working frames
  carry an empty `❯` above the status bar, so a composer alone cannot prove a
  session settled — only the footer row differs between working and parked.
- **The status bar below the composer carries unmeasured rows** — `/rc`,
  `● high · /effort`, a login-expiry notice — which is why the parked frame is
  classified from the composer box's closing divider rather than from an
  enumeration of the rows beneath it.

`working-footer-first-paint` is the first paint of a turn: the footer is
`· Tomfoolering…`, drawn with the dim `·` glyph and before the elapsed timer
appears, which is why the `workingFooterGlyphs` vocabulary set exists alongside
`spinnerGlyphs` in `crates/daemon/src/detection/rules.json`.

## What the tests assert

Each fixture records the CLI release it was captured from in its
`claudeVersion` field, and the classification tests read that field rather than
restating a version — a re-capture that bumps it moves the rules the
assertions run under with it.

The assertions name the **rule** that decided each frame, not only the status:

| Fixture | Verdict | Rule |
|---|---|---|
| `working-footer-2.1.263-*` | `busy` | `claude/busy/working-footer` |
| `working-footer-first-paint-2.1.263-*` | `busy` | `claude/busy/working-footer` |
| `parked-composer-status-bar-2.1.263-*` | `idle` | `claude/idle/parked-composer` |

A frame that still lands on the right status through a rule written for a
different release is rule selection drifting, and the status alone cannot see
it. Rules live in `crates/daemon/src/detection/rules.json`; the design is
`docs/specs/agent-status-detection-rules.md`.

## Terminal titles

These frames also pin an evidence channel the rendered grid does not carry.
2.1.263 sets its terminal title (OSC 0) on every animation frame:

- `◐` / `◑`, alternating, while a turn is in flight
- `✳` once it parks, and at startup before any turn

The title survives a full-screen repaint and a synchronized-output bracket,
which makes it the right answer for a frame the grid rules cannot read. Only
the busy form is shipped as a rule (`claude/busy/title-spinner`): `✳` is also
what the CLI sets before a turn has ever started, so it cannot tell "parked
after a turn" from "not started yet" — the one distinction an idle verdict has
to make.

## 2026-09-07 faint tab-to-accept suggestion

`faint-suggestion-composer.ansi` is the composer region of task `5d2f1c5c`'s
live session, extracted unaltered from the daemon handoff record in
`kanna-daemon_98629_2026-09-07_09-56-52.log` on desktop `desktop-aa43ab36`
(Kanna Staging). Everything above the turn's `done` footer is trimmed off; the
bytes that remain are the ones that were serialized, including the CLI's own
closing cursor move. Replay it into a 260-column terminal.

It is the frame behind the owner report that *"the placeholder text is grey,
typed text is whiter"*: the composer draws

```
ESC[0m ❯ U+00A0 ESC[2m commit this
```

— SGR 2 is faint — and `ESC[3A ESC[60D` leaves the cursor at column 2, the
start of the composer, rather than after the text. The session's typed-byte
ledger nevertheless attested `typed` and held a delivery behind it. Both
rendered facts together are what `ComposerState::SuggestionOnly` is measured
from; neither alone is enough.

The frame also carries the `/rc` status row. Nothing enumerates it: it sits
below the composer box's closing divider, and everything past that border is
read as the status bar it is.
