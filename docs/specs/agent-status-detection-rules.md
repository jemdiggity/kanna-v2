# Agent status detection rules

How the daemon decides whether an agent CLI session is `busy`, `waiting` or
`idle`, and where the patterns it decides from live.

This document covers the *detection architecture*. What the verdicts mean, who
consumes them, and the settled-frame discipline they are produced under are
unchanged and specified in `crates/daemon/SPEC.md` and
`docs/kanna-server-boundary.md`.

## The two problems

**Patterns were compiled into the daemon.** Every marker the classifier matched
— Claude's working footer, Codex's composer glyph, OpenCode's permission action
row — was a `const` in `crates/daemon/src/headless_terminal.rs`. A provider that
reshuffles its footer therefore degrades classification until a new daemon
ships. This is not hypothetical: Claude 2.1.263 dropped the `esc to interrupt`
hint its footer had carried for every earlier release, and the classifier went
from matching a busy frame to matching nothing at all — a `None` verdict, which
leaves the session's previous status latched (`docs/2026-09-06-claude-2.1.263-status-latch.md`).
OpenCode changed `escape interrupt` to `esc interrupt` inside a single day
(`docs/2026-08-08-opencode-live-idle-detection-e2e-gap.md`).

**One pattern set cannot serve two CLI versions.** Different machines, and
different people on one team, run different releases of the same agent CLI. A
constant is a single slot: measuring it against the newest CLI silently breaks
whoever is a few releases behind, and measuring it against the old one breaks
whoever upgraded. Both spellings of OpenCode's footer are pinned today only
because someone thought to keep the old one, with nothing recording *which
version each belongs to*.

## Shape of the answer

1. **Patterns are data.** A declarative rule file, `crates/daemon/src/detection/rules.json`,
   bundled into the daemon with `include_str!` and overridable from a
   machine-local file that hot-reloads into the running daemon.
2. **Every pattern carries a version range.** Rules and vocabulary entries
   declare which CLI versions they were measured against. Old and new chrome
   coexist; neither overwrites the other.
3. **Sessions carry the CLI version they are actually running.** The daemon
   probes the provider executable once per binary and records the result on the
   session, so rule selection is per session rather than per build.
4. **The rendered grid is not the only evidence.** Terminal titles (OSC 0/2) and
   progress reports (OSC 9) are provider-emitted state that survives a
   full-screen repaint; both are addressable channels in the rule file.

What does *not* change: the daemon remains the classification authority, the
`busy` / `waiting` / `idle` vocabulary is untouched, waiting stays a strict
positive match on provider-drawn chrome, DEC-2026 settled-frame discipline is
unchanged, and composer attestation semantics are untouched.

## Rule file

```jsonc
{
  "schemaVersion": 1,
  "common": {
    // Patterns that are not one provider's property: the permission wording
    // every CLI here spells the same way, and the chrome that is chrome
    // wherever it is drawn. Its vocabulary is a separate namespace from a
    // provider's — merging them would let Codex's composer glyph satisfy
    // Claude's composer test.
    "vocabulary": {
      "waitingMarkers": [
        { "id": "common/vocab/permission-question", "versions": "*",
          "values": ["do you want to allow"] }
      ]
    },
    "chrome": [
      { "id": "common/chrome/permission-mode", "versions": "*",
        "match": { "contains": "bypass permissions" } }
    ],
    // Merged into every provider's rule list before priority ordering.
    "rules": [
      { "id": "common/waiting/permission-prompt", "status": "waiting",
        "channel": "grid", "versions": "*", "priority": 10,
        "when": { "anyLineWrapped": { "containsAny": "waitingMarkers" } } }
    ]
  },
  "providers": [
    {
      "provider": "claude",
      "versionProbe": { "args": ["--version"] },
      // How many rendered rows classification reads from the bottom of the
      // screen, and how many the waiting-prompt reader needs to see a whole
      // dialog. Both default to 8; OpenCode's permission dialog is taller.
      "statusRows": 8,
      "waitingPromptRows": 8,
      "vocabulary": {
        "composerPrompts":   [ { "id": "claude/vocab/composer-prompt", "versions": "*",
                                 "glyphs": ["❯"] } ],
        "spinnerGlyphs":     [ { "id": "claude/vocab/spinner", "versions": "*",
                                 "glyphs": ["✻", "..."] } ],
        "doneFooterMarkers": [ { "id": "claude/vocab/done-footer", "versions": "*",
                                 "values": ["· done "] } ],
        "titleBusyGlyphs":   [ { "id": "claude/vocab/title-busy", "versions": ">=2.1.263",
                                 "glyphs": ["◐", "◑"] } ]
      },
      "chrome": [
        { "id": "claude/chrome/banner", "versions": "*",
          "match": { "equals": "Claude Code" } }
      ],
      "rules": [
        {
          "id": "claude/busy/interrupt-marker",
          "status": "busy",
          "channel": "grid",
          "versions": "<2.1.263",
          "priority": 20,
          "when": { "anyLineWrapped": { "contains": "esc to interrupt" } }
        }
      ]
    }
  ]
}
```

Every entry — vocabulary, chrome and rule alike — carries an `id`, unique
across the whole file, because the id is what an override replaces by.

### Rules

A rule is `{ id, status, channel, versions, priority, when }`. Rules are
evaluated in ascending `priority`, then in file order; the first match wins and
its `id` is the classification's provenance. `status` is exactly `busy`,
`waiting` or `idle`.

`channel` names the evidence the rule reads:

| Channel | Evidence |
|---|---|
| `grid` | the rendered terminal grid, after ANSI interpretation |
| `title` | the terminal title the CLI last set with OSC 0/2 |
| `progress` | the last OSC 9 progress report the CLI emitted |

Grid rules are evaluated before title and progress rules regardless of
`priority`, and a grid verdict is never overridden by another channel. The
non-grid channels answer the case the grid leaves unanswered — a `None` verdict,
which is what latches a stale status — rather than competing with a frame that
already proved something.

### Predicates

`when` is one of:

- `{"anyLine": <match>}` — any line in the classification window matches
- `{"anyLineWrapped": <match>}` — any line matches, **or** any two adjacent
  lines do once joined by a space. This is what makes a marker survive a narrow
  terminal: a footer hint drawn on one row is rendered across two, and a scan
  that only looked at single rows would silently lose the verdict exactly where
  the window is smallest.
- `{"lastNonEmptyLine": <match>}` — the last non-empty line matches
- `{"text": <match>}` — the channel's text (a terminal title) matches
- `{"progressState": ["indeterminate", ...]}` — the last progress report is in
  this set
- `{"structural": "<name>"}` — a named predicate implemented in code

A `<match>` is one of:

| Form | Matches |
|---|---|
| `contains` | ASCII case-insensitive substring |
| `containsAll` | every listed substring, in any order |
| `equals` | whitespace-trimmed equality, case-sensitive |
| `startsWith` | whitespace-trimmed prefix, case-sensitive |
| `containsAny` | any value in a named vocabulary set is a substring |
| `containsAllOf` | every value in a named set is a substring |
| `startsWithAny` | any value in a named set is a prefix |
| `startsWithGlyph` | the first non-space character is in a named set |
| `startsWithGlyphWord` | ...and the next character is whitespace |
| `allCharactersIn` | non-empty, and every character is in a named set or a space |
| `anyOf` / `allOf` / `not` | boolean combinations |

The set-valued forms name a **vocabulary set**, not a literal list, so a
version-tagged vocabulary entry automatically version-gates every matcher that
reads it. Set names are an enum, not free-form keys: a misspelling in an
override file is a load error rather than a rule that quietly stops matching.

### Structural predicates

Not every classification is a substring test. Claude's parked composer is
recognised from the shape of its composer box; Copilot's idle composer is
recognised relative to the worktree-path row. Those *algorithms* stay in code —
inventing a screen-layout language to hold five predicates would be a worse
architecture than the one it replaced — but the *literals* they walk (prompt
glyphs, divider characters, box borders, spinner sets) come from the version-
resolved vocabulary, so a glyph change is still a data change.

The named predicates are `claude-working-footer`, `claude-active-subagent`,
`claude-parked-composer`, `claude-selected-menu-option`,
`opencode-composer-status`, `copilot-busy-above-path` and
`copilot-idle-composer-below-path`. An unknown name fails rule-file validation
rather than silently matching nothing, and a test asserts the converse: a
predicate no bundled rule uses does not get to outlive it.

### What the rule file deliberately does not describe

The matcher language reads **text**: what a rendered line says, which glyphs it
opens with, which measured vocabulary it carries. A cell's *styling* is not
text, and one question the daemon has to answer depends on it — whether Claude
painted the composer line as its own faint tab-to-accept suggestion rather than
a human typing it (`ComposerState::SuggestionOnly`, `crates/daemon/SPEC.md`).

That read stays in `headless_terminal.rs`, where the grid is rendered. Adding a
styling dialect to the rule file to hold one measured fact would be the same
trade the structural predicates already refused, in the other direction: a
whole language for a single entry. The split is the same one this document
draws everywhere else — the algorithm is code, the literals are data. The cell
reader walks the version-resolved `composerPrompts` glyphs to find where the
draft starts, and the classifier decides which row is the composer at all; only
"is this cell faint, and where is the cursor" is answered off the grid.

The provider gate is data even so. `paints_faint_suggestions` names the one
provider whose suggestion styling has been captured off a real frame, and the
*chrome* half of the same fix — reading everything past the composer box's
closing divider as the status bar it is — is expressed as Claude's own
`dividerGlyphs` entry. A provider that has not been measured declares no border
glyphs, matches nothing, and is read exactly as it was.

### Version ranges

`versions` is `*`, or a comma-separated conjunction of `>=`, `>`, `<`, `<=`,
`=`/`==`, `!=` comparators over dotted numeric versions (`>=2.1.263`,
`>=1.16,<1.19`).

Versions are compared as dotted numeric release ordinals, deliberately not as
semver: the agent CLIs do not agree on a version grammar, and rule selection
needs a comparison rather than a compatibility judgement. Missing components
compare as zero, so `2.1` and `2.1.0` are the same release.

**A session whose CLI version is unknown applies every rule for its provider.**
Unknown is the state before the probe lands, on an inherited session from an
older daemon, and whenever the probe fails. Applying the union is what keeps an
unknown-version session classifying exactly as well as it did before version
gating existed; narrowing on unknown would trade a known failure mode for a
worse one.

## Capturing the CLI version

A PTY task's `Spawn` command names `/bin/zsh`, not the agent CLI: the agent is
launched from inside a login-shell command line so that repo setup runs first.
The daemon therefore cannot probe its own child. The server, which resolved the
provider executable to an absolute path to build that command line, passes it as
`Spawn.agent_executable`, and the daemon probes *that*.

The probe runs `<executable> <versionProbe.args>` (default `--version`) detached
from the session, in the session's cwd and environment, with a short timeout,
and parses the first dotted-numeric token out of stdout — falling back to
stderr, because several CLIs print their version there. It is asynchronous: the
session classifies from the unknown-version union until the answer lands, and
never blocks a spawn on it. Results are cached per executable path plus its size
and mtime, so a machine probes each installed CLI once rather than once per task.

The version travels with the session across daemon handoff
(`HandoffSession.cli_version`). A daemon that adopts from a sender too old to
send it treats the session as unknown-version.

## Overrides and hot reload

The daemon loads `detection-rules.json` from its data directory
(`KANNA_DAEMON_DETECTION_RULES` overrides the path), deep-merges it over the
bundled file, and watches it. Merge is by id: an override entry replaces the
bundled entry with the same `id` and is otherwise appended, so a fix can replace
one rule without restating the file. A file that fails to parse or validate is
refused with a logged error and the daemon keeps serving the rules it has —
a broken override must not cost a machine its classification.

Reload is a generation counter. Sessions hold a resolved rule set and re-resolve
when the generation moves, so a pattern fix reaches every live session without
restarting the daemon or the app.

The override file is also the seam for a remote update channel: fetching a newer
rule set out of band writes this file and the running daemon picks it up. That
channel — its transport, signing, and rollback — is deliberately not built here.

## Evidence channels beyond the grid

**OSC 0/2 titles are real and already usable.** Claude 2.1.263 sets its terminal
title on every animation frame: `◐`/`◑` alternating while a turn is in flight and
`✳` once it parks (measured across the captured frames in
`crates/daemon/tests/fixtures/claude/`). The title survives a full-screen repaint
and a synchronized-output bracket, which makes it the natural answer to the exact
failure the 2.1.263 latch produced — a frame the grid rules cannot read leaves
the title still saying what the CLI is doing. libghostty tracks the title, so the
channel costs nothing to read.

Only the **busy** form ships as a rule. `✳` is also the title the CLI sets at
startup, before a turn has ever run, so it cannot tell "parked after a turn"
from "not started yet" — the one distinction an idle verdict has to make, and
the one a spawned session would get wrong before its agent had drawn anything.
The busy title is purely additive: it can end a stale `idle` that real work
should have cleared, and it can never end a session early.

OpenCode sets a title too (`OpenCode`, then `OC | <task summary>`), but it
changes on turn boundaries rather than with activity, so it is chrome, not state;
the bundled file ships no OpenCode title rules.

**OSC 9 progress is supported but unused.** No CLI measured here emits it today.
It is wired up anyway — a bounded incremental scanner over the PTY byte stream,
recording the last `ESC ] 9 ; 4 ; <state> ; <percent>` report — because the point
of this architecture is that a provider shipping progress reports becomes a rule
file edit rather than a daemon release. The bundled file ships no progress rules.

## Regression fixtures

Captured frames live in `crates/daemon/tests/fixtures/<provider>/` and are tagged
with the CLI version they came from. Tests assert **which rule matched**, not only
the resulting status: a fixture that still lands on `busy` through a different
rule than the one written for its version means rule selection has drifted, and
asserting the final state alone would not notice. See those directories' READMEs
for how to re-capture.
