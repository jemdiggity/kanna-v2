# Remote Blocked Task UX Review Round 3 Design

## Goal

Close the security, lifecycle-linearization, retry-recovery, observer-ordering,
and mixed-version gaps in the replacement for PR #921 without changing the
established blocker UI, local task behavior, remote terminal routing,
read-dwell, file-link, or workspace projection behavior.

## Authenticated LAN Snapshot And Advance Requests

Modern LAN snapshot and advance requests carry a sealed JSON envelope created
with the sender's persisted transfer identity and the discovered owner's public
key. The envelope binds the action name, outer request ID, task ID, and optional
expected transition revision to the sender's paired public key. The owner
discovers the claimed peer, verifies that the discovered key is still the
paired key, decrypts with that key, verifies the bound action and request ID,
and atomically consumes a sender/action/request replay key before exposing a
snapshot or invoking the owner HTTP action.

The existing X25519/XChaCha20-Poly1305 envelope is the smallest established
primitive that proves possession of the paired private key. A new persistent
authenticated transport would protect more commands but would also require a
protocol redesign outside this review's scope. Plain caller-controlled
snapshot and advance fields are retained only as wire-compatible mirrors for
older decoders; a current owner never authorizes either operation from them.

Replay entries use the runtime's bounded request lifetime and are pruned on
each authenticated request. Advance additionally keeps owner CAS and the
per-task lifecycle lease, so a replay remains rejected after the replay cache
ages out whenever an authoritative revision was supplied.

## Mixed-Version Stage Advance

`expected_transition_revision` becomes optional at the sidecar control,
peer-request, runtime, Tauri command, relay/LAN client, and desktop action
boundaries. A current authenticated request without the field takes the
owner's existing legacy no-CAS HTTP path. A request with the field retains
strict owner CAS.

This restores old/new JSON compatibility for the revision field without
weakening sender authentication on a current owner. Serializers omit the field
when it is unavailable, so older decoders that ignore unknown fields continue
to accept modern requests and current decoders accept legacy messages.

## Per-Task Mutation Linearization

`AppState` owns one keyed task-mutation coordinator. Every lifecycle or blocker
route first resolves branch-style aliases to the durable task ID, then acquires
the same canonical task lease before validating or mutating that task.

Advance holds its lease across expected-run, running-post, closed, and blocker
checks and transfers the lease into detached transition execution. Complete,
revision, rerun, close, block, and unblock use the same lease through their
state-changing work. This makes validation plus lifecycle reservation one
linearized operation even though daemon I/O, git, and SQLite cannot share one
database transaction.

Duplicate advance requests remain idempotent: if the lease is already held,
the route returns its existing accepted response. Competing non-advance
mutations wait for the current lease and then re-read authoritative state.

## Desktop Remote Advance Reconciliation

Each pending remote advance records the expected optional transition revision
and the authoritative cloud or LAN snapshot generation from which the request
was issued. Reconciliation runs whenever the workspace or either source
generation changes.

A pending entry is removed when:

- the owner task disappears;
- the logical task is replaced by a different owner/source identity;
- the authoritative transition revision changes; or
- the same source publishes a later snapshot generation, including the
  accepted-then-detached-failure case where the revision did not change.

Removing a task clears its entry permanently; if the same task later
reappears at the same revision, it is eligible for a new request. Disposal
clears every pending entry and prevents late client acquisition from issuing
work.

## Observer Generation Fencing

The task-transfer runtime stores an observer slot per peer/session containing a
monotonic generation and an optional task handle. `observe` reserves a new slot
and aborts any displaced handle before awaiting discovery. When discovery
finishes, the new observer installs only if its generation still owns the
slot; otherwise its handle is aborted. `unobserve` removes the slot, so a
delayed observe can no longer install afterward.

Concurrent observe replacement uses the same rule: the newest generation owns
the key and every displaced or stale handle is aborted. Sidecar commands remain
concurrent, while runtime state supplies deterministic per-key ordering.

## Error Handling And Verification

- Forged or replayed authenticated requests return peer protocol errors and do
  not reach the owner Kanna server or expose task snapshots.
- Optional legacy CAS affects only revision comparison; malformed or unauthenticated
  requests remain rejected.
- Mutation waiters revalidate after acquiring the canonical lease.
- Desktop non-success responses continue to surface through the existing toast
  path.
- Focused Rust and frontend tests cover forged/replayed advance, authenticated
  snapshot exposure, old/new revision JSON, cross-action and blocker races,
  accepted-then-failed retry release, disappear/reappear, delayed observe, and
  concurrent observer replacement.
- Final verification includes desktop build/typecheck, practical JavaScript
  checks, canonical `pnpm test`, focused Rust suites, `./kd test rust`, and a
  complete diff review against `origin/main`.
