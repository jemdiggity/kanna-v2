# Daemon Process-Lifecycle Hardening Design

## Goal

Port the process-lifecycle hardening preserved at
`hardening-daemon-lifecycle-eb76b59d` onto current `origin/main` as four
independently reviewable commits, while excluding the descriptor-hygiene work
already split to task `eb76b59d` and the protocol or consumer changes owned by
follow-up tasks.

## Baseline

This branch will stack the exact prerequisite commits from task `eb76b59d`:

- `1027b7bf` — process-wide spawn/fd boundary and close-on-exec descriptor
  hygiene
- `1293308d` — safe session ids and unterminated journal-tail normalization

Those commits are dependencies, not reimplementations. Once `eb76b59d` lands,
rebasing this branch will remove them from this task's review diff.

Current `origin/main` also contains the authoritative PTY lifecycle work from
PR #922. The port must preserve its per-session lifecycle lock, retired-handle
fence, immediate adopted-reader startup, and ordered old-Exit/new-SessionCreated
publication.

## Commit 1: Identity-Safe Signalling

Introduce a macOS process-introspection boundary that represents a process as
`(pid, start_time)`. Every delayed or destructive signal must carry this
identity rather than a bare pid.

Because macOS has no pidfd, destructive signalling uses a verified stop
protocol:

1. verify the current process matches the captured identity;
2. send `SIGSTOP`;
3. verify the identity again while the process is stopped;
4. if verification fails, send `SIGCONT` as rollback and refuse the destructive
   signal;
5. otherwise signal the verified process or process group and resume where
   appropriate.

Agent and PTY teardown take a process-table snapshot, identify descendants
anchored to the verified leader, include descendants that escaped into a new
session with `setsid`, and supplement ancestry with a controlling-TTY device
sweep. A recycled leader pid must never authorize signalling its replacement
or the replacement's descendants.

This commit changes all existing daemon signal and teardown paths to use the
identity-aware APIs. It does not add successor authentication or bound the
number of concurrent agent process-table scans; those belong to tasks
`aa0ecc72` and `1161fa5d`.

## Commit 2: Central Bounded Reaper

One background owner thread receives one-shot ownership of child handles and
bare child identities. Callers never wait for child exit and never perform
reaping on a Tokio worker.

Admission has these invariants:

- it is nonblocking;
- the hard capacity counts queued and currently processed entries;
- duplicate ownership is rejected by `(pid, start_time)`, never bare pid;
- an accepted handle cannot be dropped until the child is reaped or confirmed
  no longer waitable;
- saturation returns ownership to an asynchronous overflow/backpressure path
  rather than blocking the caller or growing an unbounded deque.

The owner schedules each entry by its own next-check and escalation deadlines.
A fresh admission wakes the owner without resetting the polling cadence of
unrelated survivors. Owned children that exceed their elapsed-time deadline
receive identity-verified escalation. Bare PTY pids remain owned and retried
until `waitpid` confirms completion.

The commit also exposes the bounded lifecycle admission surface consumed by
task `1161fa5d`, without duplicating that task's agent teardown batching or
shared process-snapshot logic. As soon as this commit is verified, its exact
hash and API notes are sent to `1161fa5d`.

## Commit 3: Agent Session Incarnations

Every logical agent-session life receives a monotonically allocated,
never-reused incarnation token. Removal installs a teardown tombstone so the
same session id cannot be recreated until cleanup completes. Reservations,
respawns, readers, input plans, installers, teardown, and handoff claims must
match the exact incarnation they were created for.

Overlapping lives of one session id share an `AgentShared`, including client
writers, so identity checks alone are insufficient. A stale reader may append
to the durable journal for forensic completeness, but must not fan that output
out through the replacement's shared writers or broadcast it as replacement
activity.

There is one journal sequencer per session id across overlapping lives. The
sequencer remains alive until every life using it has finished, then is
released so churn does not retain unbounded shared state.

Exit publication is a single-owner transaction:

1. claim publication ownership for the exact incarnation;
2. finish all required journal appends;
3. fan out the final agent event;
4. publish the daemon `Exit`;
5. only then mark publication complete.

The completion state distinguishes unclaimed, in progress, and fully
published. Killing an initial reservation, an idle per-turn session, a resumed
turn, or an already naturally exited life produces at most one externally
visible `Exit`. Stdout EOF does not finalize the life while stderr can still
append or fan out output.

## Commit 4: Transactional Handoff

Handoff becomes a single-flight transaction identified by a unique owner token
and registry epoch. Only the owner may commit or roll back its seal. Concurrent
handoff attempts are rejected without disturbing the active transaction.

The old daemon:

1. authenticates its own process identity for the receiving peer;
2. seals PTY and agent registries at an epoch;
3. snapshots exact session incarnations and Exit-publication state;
4. creates claims for those exact incarnations;
5. validates descriptor provenance before transfer;
6. commits removal only after the adopter acknowledges the complete transfer;
7. otherwise rolls back only the matching owner token.

Agent pipes must belong to the claimed child identity and have the expected
read/write direction. PTY descriptors must be real masters and must resolve to
the claimed child's slave TTY device. A descriptor that is valid in isolation
but belongs to a different session is rejected.

Natural exits racing the transfer reconcile with the exact claim: the adopter
must neither resurrect a finished life nor lose a final Exit. The transferred
publication state tells the adopter whether Exit remains unclaimed, is being
completed by the old daemon, or was already fully published.

This commit keeps the deployed wire framing: one aggregate SCM_RIGHTS transfer.
It does not add multi-message chunking, new capabilities, the retryable
sealed-window client contract, or successor-peer authorization. Those remain
owned by tasks `ff5b9da6`, `1ec192c7`, and `aa0ecc72`.

## Verification

Every regression follows test-driven and mutation-verified development:

1. add a focused regression and observe the expected failure;
2. implement the smallest production change that makes it pass;
3. temporarily remove or invert the relevant protection;
4. confirm the regression fails for the intended reason;
5. restore the protection and rerun the focused test;
6. run the supported daemon suite through `./kd test rust`, which serializes
   timing-sensitive tests with `--test-threads=1`.

The two known upstream reconnect flood flakes,
`overflowing_subscriber_resyncs` and `overflowing_observer_resyncs`, are
reported separately if encountered and are not weakened or rewritten here.

Each production commit must pass its focused tests and leave the worktree clean
before the next subsystem starts. The final branch is checked for accidental
SCM_RIGHTS chunking and for changes that overlap the four related tasks.
