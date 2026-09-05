# Forge Independence

Status: proposed (design spec, no implementation yet)
Related: [native-review.md](./native-review.md), [merge-master.md](./merge-master.md),
[task-graph-stages.md](./task-graph-stages.md)

The path from single-operator Kanna to large, multi-contributor projects —
without a forge. The former native-review surface is retired; merge-master
still provides the git-first merge path. This spec answers the remaining
question: where does *shared* state live when there are N operators and no
GitHub?

**Parked behind a decision gate.** Native-review's rethink removed the
review data model this spec was going to inherit: review feedback in Kanna
is a composed message, not a stored record, and for forge users the forge
already is the shared store. Do not build phase 3+ until (a) a second real
contributor wants shared review state on a real repo, and (b) a
forge-API-backed variant (threads as PR review comments, checks as
check-runs) has been evaluated and found wanting for concrete reasons —
this spec must beat that boring competitor on evidence, not rhetoric.
Known risks to weigh at the gate: the decentralized-review graveyard
(git-appraise, git-bug, Radicle; Gerrit NoteDb is a *centralized* server
using git storage, a weaker precedent than it looks), DIY trust-system
subtlety (the roster/validity design needs hostile external review before
a merge policy trusts it), and the split-brain middle state while a team
is half-migrated.

## Thesis

Strip a forge to its kernel and it is four things: a highly-available git
remote, ref authorization, a shared metadata database keyed to commits
(reviews, verdicts, checks), and a merge serialization point. Git already
distributes content; the forge's residual monopoly is distributing the
*judgments*. Put the judgments in git too — signed, append-only — and the
forge degrades into a dumb, swappable remote.

The Linux kernel proves this model at maximum scale: judgments embedded in
commits (trailers), the roster as a committed file (`MAINTAINERS`), signed
tags as authorization, federated verification (0-day, syzbot), discussion
archived as git (lore/public-inbox), serialization by a hierarchy of
maintainers. Its only real defect is encoding: judgments are prose scraped
by tools, and the contribution ritual is a human-onboarding cliff. Agents
pay that tooling tax for free — text-first, ceremony-heavy, asynchronous
protocols are agent-native. Kanna's move is the kernel's architecture with
the encodings modernized.

Design invariants, in force everywhere below:

1. **The record is self-authenticating.** Every shared fact is a signed,
   append-only event. Verification never depends on which channel
   delivered it.
2. **Channels are untrusted and lossless-optional.** Losing a transport
   costs freshness, never truth.
3. **Git is the source of durability.** Everything else — SQLite, relay,
   inboxes — is a view or a hint.

## The event

One envelope for every shared fact. Canonical JSON (RFC 8785 JCS) signed
with `ssh-keygen -Y sign`:

```json
{
  "event": {
    "v": 1,
    "id": "01J9ZK7Q4R8XN2M5P0WVT3E6BD",        // ULID, assigned at creation
    "ts": "2026-07-07T12:34:56Z",
    "task": "8f41c409",                          // pipeline_item id; absent for repo-scoped events
    "type": "thread.open",
    "author": "jeremy",                          // roster principal
    "body": { }                                  // type-specific, schemas below
  },
  "sig": {
    "key": "ssh-ed25519 AAAA…",                  // public key, must appear in roster
    "namespace": "kanna-event@1",
    "signature": "-----BEGIN SSH SIGNATURE-----…"
  }
}
```

- `id` is a ULID: unique, lexically time-sortable, assignable offline.
  Cross-references between events use ids (a thread's id is its
  `thread.open` event id).
- The signature covers the JCS bytes of `event` only. `sig.key` must
  belong to `event.author` in the roster **as of the event's position**
  (see roster validity).
- Unknown `type`s and unknown `body` fields are preserved and ignored —
  forward compatibility is load-bearing for mixed-version teams.

### Event types and bodies

| type | body | notes |
|---|---|---|
| `thread.open` | `{file_path, side, line_start, line_end, anchor_commit, anchor_excerpt, text, severity?}` | excerpt-based anchor (survives revision forks); `severity`: `blocking`/`advisory`/`nit` |
| `thread.comment` | `{thread, text}` | `thread` = thread.open event id |
| `thread.resolve` / `thread.reopen` | `{thread, reason?}` | resolve by the change author ≠ resolve by reviewer; fold tracks who |
| `verdict` | `{stage_run?, decision, summary, threads?}` | `decision`: `approve` / `request-changes` / `escalate` |
| `check` | `{commit, name, status, detail?, log_ref?}` | `status`: `pass`/`fail`/`error`; signed by a `runner` key |
| `merge` | `{source_branch, target_branch, merge_commit, strategy, approvals}` | `approvals` = verdict event ids the merge relied on |
| `task.meta` | `{title?, prompt?, stage?, closed?}` | enough shared task state for teammates' sidebars |
| `roster.change` | `{roster_commit}` | pointer to the commit that changed `.kanna/roster.json` |
| `calibration` | `{verdict, outcome, evidence}` | joins reality back to a judgment (phase 4) |

Escalation is a first-class `verdict.decision`, not a comment convention:
"needs a human, here's why" routes to the review inbox like any awaiting
verdict.

### Fold (deriving state)

State = a deterministic fold over the union of all writers' logs:

- Order events by `(ts, id)`; ties cannot collide because ULIDs embed
  randomness. Per-writer logs are already internally ordered; the fold is
  a merge of sorted streams.
- Duplicates (same `id`) collapse to one.
- Thread status is the last resolve/reopen in fold order, tagged with the
  resolver's role (author-resolve vs reviewer-resolve are distinct).
- Events that fail signature or roster validation are **quarantined**, not
  dropped: retained, excluded from state, surfaced in a diagnostics view.
  A misconfigured clock or an offboarded key must be debuggable, not
  silent.
- The fold is pure and versioned (`fold@1`). Changing fold semantics is a
  spec change, because two instances disagreeing on derived state is the
  one unrecoverable sin.

## Storage: git is the database

- Events live under **per-writer refs**: `refs/kanna/events/<key-fpr>`
  where `<key-fpr>` is the hex SHA-256 fingerprint of the signing key.
  One writer per ref means every push is a fast-forward by construction —
  no write contention, ever. (A person with two devices has two keys and
  two refs; the roster maps both to one principal.)
- Each git commit on an event ref carries exactly one event at path
  `event.json`; commit timestamp mirrors `event.ts`. The chain gives
  per-writer ordering and tamper evidence: rewriting history under an
  event ref is a non-fast-forward that every peer's stored tip detects.
- Ingest = walk new commits since the last seen tip, verify, fold.
  Sync = `git fetch 'refs/kanna/events/*'` + push own ref. Any dumb
  remote works: bare repo over SSH, Gitea, or GitHub demoted to byte
  hosting — the only centralized component left.
- Each instance's SQLite remains the **materialized view** of the fold
  (Gerrit NoteDb's design, proven at Android scale). The `/v1` API and
  MCP tools sit on the view; kanna-server's storage layer learns to sync.

## Transport: pluggable, untrusted

| Transport | Role | Latency |
|---|---|---|
| git push/fetch | Durability; the baseline that is always true | seconds, pull-based |
| Kanna relay | Liveness hints for the tight same-team loop | ~100ms hint + fetch |
| Email | Reach: cross-org, and humans who will never install Kanna | seconds–minutes |

- **Relay hints** are one message type: `{repo, kind: "events"}` — no
  event data, so the relay stays untrusted and optional. Receipt triggers
  a sync; absence degrades to polling (configurable interval).
- **Email** carries full events as multipart mail: a `text/plain` part
  rendered for humans (kernel-style quoted context) plus
  `application/vnd.kanna.event+json` parts — the calendar-invite (iMIP)
  pattern. Threading maps to `Message-ID`/`In-Reply-To`. A resident
  **postmaster agent** bridges: inbound mail → verify signed part →
  append to its own event ref on the sender's behalf is **not** allowed —
  the sender's signature is the sender's; the postmaster merely ingests
  and relays. A non-Kanna human replies in plain text; the postmaster
  wraps the reply as a `thread.comment` signed by the postmaster key with
  `body.on_behalf_of` set, and policy decides what that's worth.
- At-least-once, unordered delivery is safe by construction: events are
  idempotent and the fold is order-insensitive across writers.

## Identity: zero new ceremony

- Identity = the SSH key contributors already push with; git signs with
  it natively (`gpg.format ssh`, git ≥ 2.34). kanna-server signs via the
  user's ssh-agent socket — private keys are never read. Users without
  SSH keys get a generated ed25519 signing key in the macOS Keychain.
- **Roster**: `.kanna/roster.json` is authoritative; a derived
  `.kanna/allowed_signers` is committed beside it so plain
  `git verify-commit` / `ssh-keygen -Y verify` work with no Kanna
  installed. The roster-change flow regenerates both in one commit.

```json
{
  "v": 1,
  "members": [
    {"principal": "jeremy", "role": "human", "keys": ["ssh-ed25519 AAAA…"],
     "email": "gu.jungun@gmail.com"},
    {"principal": "merge-master", "role": "merge-master", "keys": ["…"]},
    {"principal": "ci-mac-mini", "role": "runner", "keys": ["…"]}
  ],
  "policy": {
    "roster_change": {"require": {"human": 1}},
    "merge": {"require_verdicts": {"human": 1},
               "require_checks": ["unit"],
               "trusted_runners": ["ci-mac-mini"]},
    "subsystems": [
      {"paths": ["crates/daemon/**"], "resident": "daemon-maintainer",
       "owner": "jeremy"}
    ]
  }
}
```

- **Validity chain**: roster at commit N is valid iff the commit that
  introduced it satisfies `policy.roster_change` of the roster at N−1.
  Genesis (the founder's first roster commit) is axiomatic — every trust
  system has one.
- **Point-in-time validity**: an event verifies against the roster as of
  the event's `ts` position in the roster's history, so rotation and
  offboarding never invalidate old records. Backdating with a stolen key
  is tamper-evident (per-writer ref rewrites are visible
  non-fast-forwards against peers' stored tips).
- Roles: `human`, `merge-master`, `runner`, `resident`, `postmaster`.
  Policy references roles and principals; verdict weight is a policy
  concern, not an envelope concern.

## Serialization: CAS, not a coordinator

Remote git ref updates are atomic compare-and-swap. The merge master:

1. folds current state; checks `policy.merge` (required verdicts present,
   signed by qualifying keys; required checks green from trusted
   runners),
2. prepares the merge commit locally,
3. `git push --force-with-lease=refs/heads/<target>:<expected-tip>`,
4. on rejection: fetch, re-verify policy against the new tip, retry,
5. appends a `merge` event citing the verdict event ids it relied on.

No merge-queue service exists; correctness comes from the lease, ordering
from the single per-repo merge master (an optimization, not a
requirement). Where the remote is controllable, a pre-receive hook
enforcing "target branch updates must come from a `merge-master` key"
adds server-side depth; where it isn't, the signed merge events make any
bypass visible after the fact.

## Scale: the agent hierarchy

- **Path-scoped resident maintainer agents** — `policy.subsystems` maps
  path patterns to a resident agent and a human owner. `MAINTAINERS` was
  accidentally a context-sharding scheme: partition-by-subsystem answers
  scarce attention *and* scarce context. Residents review changes
  touching their paths, file threads, issue verdicts, and escalate.
  Engine primitive required: the find-or-create-and-signal singleton from
  merge-master.md, keyed by `(repo, agent)` — already specced.
- **Continuous integrator** — a resident that merges in-flight branches
  on every push (linux-next at machine cadence) and files
  `thread.open` events for semantic conflicts between them.
- **Calibration** — `calibration` events join outcomes back to verdicts
  (approved change reverted? trusted check went green on a regression?).
  Per-domain earned weight ("approvals count in `drivers/`, not `mm/`")
  feeds `policy.merge`. Deliberately last: policy is only trustworthy
  once verdicts, threads, and checks have been structured data for a
  while.
- Ceremony stops filtering once agents make it free; the gate moves to
  identity plus computable track record. This is the spam defense — a
  flood of perfect-looking contributions is rate-limited by what its
  signing keys have earned.

## Integration with the codebase

- New crate `crates/kanna-events`: envelope types, JCS canonicalization,
  ssh sign/verify (via ssh-agent), roster parsing/validity chain, the
  versioned fold. Shared by kanna-server, kanna-cli, and tests. No I/O —
  storage and transport live with their owners.
- New crate boundary aside, existing shared state is the seed corpus:
  `stage_run` results/feedback and merge outcomes already capture
  verdict-shaped facts. If this spec is ever built, the first migration
  derives `verdict`/`merge` events from that history rather than starting
  empty.
- kanna-server (`crates/kanna-server`):
  - an `event` table (`id, task_id, type, author, ts, body, sig,
    quarantined`) as the local materialized store, populated from engine
    actions (verdicts from stage actions, checks from runners, merges
    from the merge master).
  - a `git-sync` module — ingest/egress walker over
    `refs/kanna/events/*` (git2, already vendored), sync scheduling
    (relay hint → sync; fallback poll), and quarantine surfacing.
  - `/v1` additions: `GET /v1/tasks/{id}/events`, `GET /v1/repos/{id}/roster`,
    `POST /v1/repos/{id}/sync`; SSE gains `events_appended {task_ids}`.
- MCP/CLI (`crates/kanna-tool-catalog`): `kanna_issue_verdict`,
  `kanna_report_check`, `kanna_sync_repo`.
- Desktop: no new review surface beyond native-review's; the review inbox
  gains escalations and a quarantine/diagnostics view later.

## Staging

1. **Native review** ([native-review.md](./native-review.md)) — retired. No
   current dedicated review surface or dependency on this spec.
2. **Merge without the forge** ([merge-master.md](./merge-master.md)) —
   merge master, git-first agents, CAS push.
3. **Shared metadata** *(gated — see the decision gate above)* — the
   `kanna-events` crate; event log under `refs/kanna/events/*`; local
   `event` table as materialized view; roster + validity chain; relay
   hints; second-contributor onboarding = clone + roster entry.
4. **Team scale** — path-scoped residents, escalation routing,
   calibration records, policy-weighted merge. Postmaster/email gateway
   any time after 3.

## Testing expectations

- `kanna-events`: property tests — fold determinism (any interleaving of
  writer logs folds identically), idempotence, quarantine on bad
  sig/roster; roster validity-chain fixtures (rotation, offboarding,
  genesis, backdating attempt).
- Sync: two kanna-server instances against a bare-remote fixture —
  concurrent writes, offline catch-up, tip-rewrite detection. Extends the
  existing `http_api/tests` style.
- Merge CAS: race two merge masters at one remote; exactly one merge
  event, loser retries cleanly.
- Desktop E2E (mock): review round trip asserting the underlying records
  are events (phase 1); two-instance shared-review E2E when phase 3
  lands.
- Email: postmaster round-trip against a local SMTP/IMAP fixture —
  outbound render, inbound verify, `on_behalf_of` wrapping (phase 4).

## Open questions

- **Event retention/compaction**: per-writer logs grow forever; likely
  fine for years (events are small), but a checkpoint/archive scheme
  (fold snapshot + ref truncation with signed checkpoint) needs design
  before very large deployments.
- **Task identity across instances**: ULIDs avoid collision, but two
  operators independently creating "the same" task is a human-level
  dedup problem; punt — tasks are cheap and closable.
- **Roster bootstrap UX**: founder genesis is axiomatic, but the
  second-contributor invitation flow (send roster-change proposal by
  email? by branch?) deserves a concrete design in phase 3.
- **Clock skew**: fold order uses `ts`; skewed clocks reorder
  cross-writer interleavings harmlessly (fold is still deterministic)
  but can misorder a conversation's rendering. Consider hybrid logical
  clocks in `v2` if it bites in practice.
