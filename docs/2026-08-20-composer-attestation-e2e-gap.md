# Composer attestation: what the remote-e2e harness cannot drive

Date: 2026-08-20
Related: `crates/daemon/SPEC.md` ("Two things withhold a logical message"),
`crates/daemon/src/session.rs::attest_empty_composer`,
`tests/remote-e2e/src/scriptedAgent.ts`

## Why this note exists

A logical task input is withheld from the PTY while a producer-declared raw
draft is active. Composer attestation is what releases it without a human: the
daemon reads the provider's own idle composer out of the headless terminal and,
only on a positive match with nothing typed into it, clears the draft and
dispatches the queued message.

Two halves of that behaviour cross server → daemon → PTY. Only one of them has
end-to-end coverage:

| Half | Covered end to end? |
|---|---|
| held-and-refused — a declared draft holds the message, the delivery answers `409 input_held_by_draft`, the message goes out at the producer's boundary | **Yes.** `tests/remote-e2e/src/lan-layer.e2e.test.ts` ("keeps a LAN terminal draft separate from a simultaneous logical task message") and `tests/remote-e2e/src/terminal-flow.e2e.test.ts` (the raw-draft and bracketed-paste cases) |
| attested-and-delivered — a declared draft that left nothing at the prompt is cleared from a rendered frame and the queued message is delivered | **No.** This gap |

## What blocks it

The remote-e2e scripted agent (`tests/remote-e2e/src/scriptedAgent.ts`) renders
no provider composer chrome, and it cannot be made to while keeping its current
shape:

1. **Its heartbeat writes below the composer.** The agent runs a background
   subshell printing `SCRIPT_HEARTBEAT <n>` (and periodically `SCRIPT_READY`)
   every 0.25 s. `composer_state_from_lines` requires the prompt glyph to be the
   last prompt line in the 8-row status window **with only provider chrome below
   it**, and `SCRIPT_HEARTBEAT 3` matches no chrome rule for any provider. So
   there is no frame in which the composer is attestable.
2. **Suppressing the heartbeat is not local.** It is what keeps the session's
   detected status fresh, and twelve specs in `terminal-flow.e2e.test.ts` and
   `lan-layer.e2e.test.ts` share this fixture. Turning it off for one case
   changes status detection for the ones that depend on it.
3. **Redrawing the composer after each heartbeat races.** It would put the
   heartbeat subshell and the main input loop on the same PTY both trying to
   leave the composer as the last line. Whether a given frame attests would then
   depend on which writer won — a coin-flip test, which is worse than none.

The scripted task spawns as Codex (`terminalFlowTestUtils.ts`), whose `›`
composer *is* one of the two attestation matches, so the provider is not the
obstacle. The fixture's output shape is.

## What would make it testable

A scripted-agent mode that owns its whole frame: no background writer, and the
main loop redrawing an idle Codex composer (`›` as the last line, nothing but
blank lines under it) after every input it consumes. That is a rewrite of the
fixture's output model rather than an option on it, because the heartbeat and
the composer want to be the last thing on screen at the same time. It should be
done when the fixture is next reworked for another reason, not as a change
riding along with an input-path fix.

## What covers it meanwhile

Daemon-level, in `crates/daemon/src/session.rs`'s test module — these exercise
the real `HeadlessTerminal`, the real `composer_state`, and the real
coordination state, and differ from an E2E only in that the frames are written
by `mirror_output` rather than by a child process:

| Test | Pins |
|---|---|
| `a_declared_draft_over_a_provably_empty_composer_releases_the_held_message` | a navigation-key draft over a rendered empty Claude composer is attested away and the held message is dispatched with its acknowledgement intact |
| `a_declared_draft_still_queued_for_the_pty_is_never_attested_away` | a frame older than the declared draft's PTY write is not evidence about it |
| `a_declared_draft_with_no_frame_rendered_since_is_never_attested_away` | the write landing is not enough on its own; the message is released only once the provider has repainted since |
| `a_composer_holding_text_keeps_holding_the_message` | a composer with text in it is never attested, so draft isolation is unchanged |
| `inherited_unknown_draft_state_unblocks_from_a_provably_empty_composer` | the inherited-unknown path (unchanged by this work) still resolves from a rendered frame |

What these cannot prove, and what the E2E above would: that a real provider
process repainting a real PTY produces a frame the daemon reads as attestable,
and that the release survives the full server → daemon → PTY path. Until then,
the attested-and-delivered path is verified at the daemon boundary only.

## Update, later on 2026-08-20: the ledger path *is* covered end to end

The work that added the typed-byte ledger (`docs/task-specs/b30b165f.md`)
changed what "attested" can mean. Attestation no longer needs a frame at all
when the daemon counted zero typed bytes, and that half runs over the real
socket against a real daemon process in
`crates/daemon/tests/reconnect.rs`:

| Test | Pins |
|---|---|
| `a_declared_draft_that_typed_nothing_delivers_through_a_rendered_suggestion` | a declared draft with nothing typed into it delivers through a composer rendering the CLI's suggestion, the message reaches the PTY, and `List` reports `composer_attestation: "not-typed"` |
| `a_typed_draft_still_holds_a_message_behind_a_rendered_suggestion` | the same frame with real keystrokes behind it still answers `LogicalInputHeldByDraft` and reports `"typed"` |

Both spawn `/bin/sh` declared as a Claude session, so the provider composer
matchers apply to a script the test controls — which is exactly the fixture
shape this note said the remote-e2e harness could not produce.

**The gap above is unchanged for the frame path.** What is still uncovered is
the original case: a real provider process repainting a real PTY into a frame
the daemon reads as an *empty* composer, releasing a message that a declared
draft had held. That is the attested-and-delivered row in the table above, and
it still waits on a scripted-agent mode that owns its whole frame.

## Update, 2026-09-08: attestation no longer gates delivery

The owner directive of 2026-09-08 removed the input hold entirely — a logical
message is written with its submission boundary immediately, whatever is on the
composer. So the "held-and-refused" and "attested-and-delivered" halves above
are no longer *delivery* behaviours, and the tests this note named for them
have been rewritten or removed with the hold.

What survives is the question attestation was always separately answering:
whether text on a composer line was typed by somebody (`typed`), is provably
the provider's own chrome (`not-typed`), or cannot be proven either way
(`unknown`). Nothing in the codebase may read composer text as an instruction
unless it is `typed`, so a frame that wrongly resolves to `not-typed` is still
the harm this note is about.

**The gap is unchanged in substance.** What is still uncovered end to end is a
real provider process repainting a real PTY into a frame the daemon reads as an
*empty* composer, resolving a declared draft to `not-typed` over the full
server → daemon → PTY path. It still waits on a scripted-agent mode that owns
its whole frame, for the reasons in "What blocks it" above.

What covers it meanwhile has moved with the rename, and now pins attestation
rather than release:

| Test | Pins |
|---|---|
| `crates/daemon/src/session.rs`: `a_declared_draft_over_a_provably_empty_composer_attests_not_typed` | a navigation-key draft over a rendered empty Claude composer resolves to `not-typed` |
| `crates/daemon/src/session.rs`: `a_declared_draft_still_queued_for_the_pty_is_never_attested_away` | a frame older than the declared draft's PTY write is not evidence about it |
| `crates/daemon/src/session.rs`: `a_declared_draft_with_no_frame_rendered_since_is_never_attested_away` | the write landing is not enough on its own; only a repaint since resolves it |
| `crates/daemon/src/session.rs`: `a_composer_holding_text_is_never_attested_empty` | a composer with text in it keeps attesting `typed` |
| `crates/daemon/tests/reconnect.rs`: `a_faint_suggestion_with_the_cursor_at_the_start_clears_the_ledger` | over a real daemon socket, a faint suggestion frame resolves an armed ledger to `not-typed` |
