# Task 1ae31eff — prevent cross-task revision verdicts

## Goal

Investigate the 2026-08-27 staging incident where task `08c44209` spent a
revision round on feedback belonging to task `5bd41e2c`, determine from durable
records whether the caller or server misrouted the request, and prevent the
same failure from claiming another task's revision budget.

## Scope

- Correlate both tasks' review/revision `stage_run` rows, revision-requested
  events, request logs, and retained reviewer transcripts.
- Make revision conclusions identify and validate the review stage run they
  conclude, or add an equally strong server-side guard justified by the
  evidence.
- Cover mismatched task/run rejection and legitimate concurrent review
  conclusions with server integration tests.
- Document recovery for a mis-claimed round via the existing desktop human
  revision action, and add real E2E coverage or a dated E2E gap note.

Out of scope: changing revision-budget semantics, adding general budget repair
machinery, or redesigning provider prompt transport to remove prompts from
process arguments (the newly established source of the misleading output).

## Constraints and done condition

Preserve human-origin revision behavior and existing revision resume/fallback
semantics. The investigation must answer which reviewer issued the bad call,
whether the server routed what it was asked, and whether `08c44209` received a
genuine review verdict. Relevant server tests and formatting must pass; clippy
must be run and this change must introduce no new findings.

## Investigation findings (staging durable records and retained transcripts)

- `08c44209`'s own review run
  `run-08c44209-1787801107645346000` issued the only request against that task.
  Its retained Codex JSONL records the CLI call with task id from that session,
  the genuine mobile-queue summary, and the genuine mobile-queue prompt. The
  `task.revision_requested` event at `2026-08-27 04:06:10` has that summary;
  its review run ended `failed`, round 1 was claimed, and the server spawned
  `run-08c44209-1787803570646836000` in the correct task/worktree at 04:06:29.
- The spawned revision's retained JSONL starts with that same genuine prompt.
  At 04:25:13 it ran `pgrep -fl 'cargo|rustc|ghostty'`. Kanna passes PTY task
  prompts in the provider process command line, so `pgrep -f` printed the full
  concurrently running `5bd41e2c` round-3 prompt. With no user input or Kanna
  delivery between those records, the model incorrectly treated process-list
  output as a replacement assignment, reverted its in-progress mobile changes,
  and refused the other task's work.
- `5bd41e2c`'s own reviewer independently issued its correct request at
  04:23:23. Its event, failed review run, round-3 count, fresh spawn, feedback,
  worktree, and retained transcript all belong to `5bd41e2c`. It did not call
  twice and did not target `08c44209`.

Therefore the server routed both revision requests exactly as asked. The
incident report's premise that the other feedback was delivered in the
revision prompt is disproved by the retained session input: this was untrusted
cross-process command-line output misread by the agent after a correct spawn.
`08c44209` did receive and conclude a genuine review verdict; the incoming
revision transition correctly ended that review. Its round was genuinely
claimed, but the revising agent abandoned it for the wrong reason.

## Delivered guard and recovery

Agent-origin revision requests are now bound to the immutable review
`stage_run` id stamped into the caller's spawn context. A task/run mismatch,
stale or non-running main run, or missing id on a newly bound run is refused
before preparation, review termination, or budget claim. Human-origin desktop
revisions retain their existing recovery behavior: the human revision action
bypasses and resets the automatic count. For this incident specifically, that
action is appropriate only if the owner wants another implementation pass;
the recorded round itself was a genuine verdict, not a server-misclaimed slot.
