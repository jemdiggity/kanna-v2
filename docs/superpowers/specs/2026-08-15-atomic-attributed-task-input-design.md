# Atomic, Attributed Task Input Design

**Date:** 2026-08-15

## Problem

Kanna currently has two terminal-input paths. Raw operator keystrokes arrive on
KSP `TermInput` frames and are forwarded by a per-connection terminal-control
worker. Complete messages from the HTTP/MCP API and server-owned lifecycle
features open separate daemon connections, write the text, wait 150 ms, and
write Enter. The daemon orders each write, but it has no concept of a logical
submission spanning multiple writes.

Consequently, concurrent producers can place bytes between a message and its
Enter, append a system notification to an unfinished operator draft, or combine
two independently intended messages into one agent submission. A frontend lock
cannot solve this because mobile, MCP, task lifecycle, and completion
notifications do not share a frontend.

The strings reported as unsolicited quick actions have a separate cause. They
are Codex composer placeholders, including `Implement {feature}`, embedded in
the Codex CLI. Kanna's plain-text task-log rendering strips the dim terminal
styling that distinguishes a placeholder from submitted input. The repository
does not currently contain a quick-action surface that sends those strings.

## Requirements

1. Every destination task session has one server-owned serialization point at
   the terminal-input boundary.
2. A logical message is submitted atomically: no producer can insert bytes
   between its text and its Enter.
3. An operator draft that begins with raw terminal input owns the input turn
   until it is submitted, cancelled, or its session ends. Complete messages
   wait behind it and cannot be appended to the draft.
4. Ordering is FIFO by admission to the destination session queue. The queue is
   scoped to the observed session incarnation, so queued input cannot steer a
   replacement run with the same task/session identifier.
5. Existing no-blind-retry and uncertainty behavior remains intact. Definite
   failures may be reported; a write whose acceptance is unknown is never
   replayed.
6. Every completed or possibly completed submission retains a source and a
   submission boundary in the task event feed and task-log API.
7. Unresolved template placeholders are invalid for quick-action submissions.
   Validation is structural; Kanna does not blacklist ordinary phrases.
8. Active Codex composer placeholders are labelled as non-submitted chrome in
   task logs.

## Source vocabulary

Input attribution is a closed wire enum:

- `human`: desktop terminal, desktop agent composer, or mobile composer
- `quick_action`: a future explicit suggestion/template action
- `api`: `send_task_input`, CLI, MCP, or another API caller
- `completion_notification`: server-generated `TASK ... DONE [...]` input
- `stage_post`: workflow post input
- `system`: other server-owned blocker, transfer, and lifecycle messages

The HTTP request accepts an optional `source`. Its omission means `api`, which
preserves existing CLI/MCP clients. Mobile sends `human` explicitly. Internal
call sites do not round-trip through HTTP; they pass their source directly to
the coordinator. `quick_action` is never inferred from message text.

## Server-owned coordinator

`AppState` owns one `TaskInputCoordinator`. The coordinator creates a worker
for each `(session_id, expected_pid)` incarnation. All input producers enqueue
commands to that worker:

- `SubmitMessage { text, source, response }`
- `OperatorBytes { bytes, source, response }`

Sequence numbers are allocated when a worker admits a new logical submission,
not when a producer finishes writing it. A complete `SubmitMessage` is one
queue item. The worker sends its normalized text as an acknowledged,
PID-fenced daemon input, waits the existing paste-disambiguation delay, and
sends a PID-fenced Enter before accepting the next item.

The first non-control `OperatorBytes` chunk opens a human submission and
receives its sequence number. Later chunks for that draft are part of the same
submission, even when complete messages have since queued behind it. Enter
closes the boundary. Ctrl-C cancels it after the byte is forwarded. While a
draft is open, queued complete messages remain blocked; a disconnect alone
does not release them into the partial composer. They resume only after an
Enter/Ctrl-C for that same incarnation or fail when the incarnation exits or
is replaced.

Terminal resize is not input and continues through the existing ordered
terminal-control path. Input itself no longer does. KSP discovers the live
session PID before the first operator bytes and submits them to the shared
coordinator. The coordinator uses acknowledged PID-fenced daemon commands for
both raw bytes and complete messages. The acknowledgement preserves the
existing uncertainty boundary, and the daemon rejects a stale worker even if a
session ID is reused.

### Failure and reconnect rules

- A definite pre-write connection or incarnation failure fails that item and
  the remaining items for the stale worker. It is not moved to a replacement.
- Losing an acknowledgement after a write is `delivery_uncertain`. The worker
  records that fact and never replays the write.
- If uncertainty occurs during an open human draft or between message text and
  Enter, the incarnation worker is poisoned: queued messages fail rather than
  risk concatenation with unknown terminal state.
- A later input discovers the current incarnation and may create a fresh
  worker, preserving existing daemon reconnect behavior without violating the
  no-retargeting contract.
- Successfully acknowledged messages remain exactly once. The coordinator
  does not add durable later-run delivery or automatic retries.

## Attribution and audit surface

The coordinator appends `task.input` events after a submission is delivered or
when its delivery becomes uncertain. Each payload includes:

- `source`
- `queueSequence`
- `sessionPid`
- `delivery` (`delivered`, `uncertain`, or `cancelled`)
- `boundary` (`message`, `terminal-enter`, or `terminal-cancel`)
- an exact bounded text value for complete messages, with `truncated` when
  necessary

Raw terminal editing cannot be reconstructed reliably from bytes because
cursor movement, deletion, and full-screen TUI commands change composer state.
Its event records the boundary and source without claiming an inaccurate text
transcript. Task logs append a compact input-audit section sourced from these
events. `/v1/task-events` exposes the structured events unchanged.

Definite failures that wrote nothing are not steering events and are not added
to the audit. Uncertain writes are included because they may have steered the
agent.

## Quick-action validation and waiting gate

A quick-action UI must place its rendered message in the composer for review;
one click must never send it directly. Submission uses the same explicit send
gesture as an operator-composed message. While the destination reports
`Waiting`, the action is disabled and labelled as requiring an answer to the
agent's pending prompt.

The shared client validator rejects unresolved `{identifier}` template tokens
for `quick_action` input before transport. The server repeats this validation
as a trust-boundary check for every client. Empty substitutions and escaped or
malformed templates are validation errors owned by the quick-action renderer.
Normal text such as “Explain this codebase” and “Run /review on my current
changes” remains valid; no phrase list is used.

Because no quick-action UI exists in this source tree today, this change adds
the source/validation contract and tests rather than inventing a new UI.

## Codex placeholder disambiguation

Task-log snapshot rendering uses provider and terminal structure, not phrase
matching. When the live Codex snapshot ends in the current composer line
(`› ...`) followed by Codex status/footer chrome, the rendered line is prefixed
with `[current Codex composer placeholder — not submitted]`. Earlier transcript
lines, including identical legitimate user text, are untouched. This preserves
the log evidence while preventing dim-style loss from turning placeholder
chrome into apparent user input.

## Verification

The central regression uses the real HTTP/KSP boundaries and a recording fake
daemon. It establishes a partial terminal draft, admits mobile-human, API, and
completion-notification messages in a controlled order, then submits the
draft. It asserts the daemon observes four distinct Enter-delimited
submissions, in admission order, with no interleaving or concatenation, and
that the corresponding `task.input` events retain distinct sources and
boundaries.

Narrow tests additionally cover stale-PID fencing, uncertain-write
non-retry/poisoning, raw-draft cancellation, source defaults, mobile human
attribution, unresolved quick-action placeholders, legitimate phrase
acceptance, and Codex placeholder labelling without rewriting transcript text.
