# Forge Independence

Status: proposed (direction sketch)
Related: [native-review.md](./native-review.md), [merge-master.md](./merge-master.md)

The path from single-operator Kanna to large, multi-contributor projects —
without a forge. Builds on native-review (review in-app) and merge-master
(merge git-first) by answering the remaining question: where does *shared*
state live when there are N operators and no GitHub?

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

## The unit: signed events

Everything shared is an **append-only, self-authenticating event**: thread
opened, comment added, verdict issued, check reported, merge performed,
roster changed. Events are SSH-signed by their author, idempotent, and
order-insensitive (state is derived by folding the log). This is the one
day-one constraint on nearer-term work: native-review's records must be
*modeled* as events even while stored in SQLite, so the storage swap later
is mechanical, not semantic.

## Storage: git is the database

- Events live under per-writer refs — `refs/kanna/events/<key-id>` — so
  every push is a fast-forward of a ref only its author writes: no write
  contention, ever. Readers fetch all writers' logs and union them.
- Each instance's SQLite is a **materialized view** of the folded log
  (Gerrit NoteDb's design). The `/v1` API, MCP tools, and review UI from
  native-review are unchanged; only kanna-server's storage layer learns to
  sync.
- Any dumb remote works: bare repo over SSH, Gitea, or GitHub demoted to
  byte hosting. The remote is the only centralized component left.

## Transport: pluggable, untrusted

The event is the unit; delivery is a detail. Three transports, one
invariant — the record is self-authenticating, the channel is untrusted
and lossless-optional (losing it costs freshness, never truth):

| Transport | Role |
|---|---|
| git push/fetch | Baseline and source of durability; always true |
| Kanna relay | Liveness hints ("repo X: refs changed") for the tight same-team agent loop; notify-then-fetch, seconds end-to-end |
| Email | Reach: cross-org, and humans who will never install Kanna |

Email deserves the emphasis: it is a forty-year-old federated relay with
store-and-forward, push delivery, and thread structure (`Message-ID` /
`In-Reply-To`) built in. Events travel as multipart mail — human-readable
body plus a structured signed part, the calendar-invite (iMIP) pattern — so
a non-Kanna teammate reviews by replying to a patch mail, full stop. A
resident **postmaster agent** bridges: inbound mail → verify signed part →
append event; outbound event → render mail. Endgame: a Kanna maintainer
agent can participate in any mailing-list project (including the kernel)
with zero adoption on their side.

## Identity: zero new ceremony

- Identity = the SSH key contributors already push with; git signs with it
  natively (`gpg.format ssh`, since 2.34). Signing happens via ssh-agent;
  Kanna never touches key files. No-SSH users get a generated ed25519 key
  in the Keychain.
- The **roster** is a committed allowed-signers file in `.kanna/` with
  roles (`human`, `merge-master`, `runner`, resident agents) — plain
  `git verify-commit` works without Kanna. Membership and policy changes
  are themselves reviewed, signed commits: a chain of custody from the
  founder's genesis commit (validity of roster N is judged by roster N−1).
- Point-in-time validity: records verify against the roster as of their
  DAG position, so rotation and offboarding never invalidate history.
  Per-writer append-only refs that peers have already fetched make
  backdating tamper-evident (rewrites are visible non-fast-forwards).

## Serialization and the agent hierarchy

- Mechanical merge ordering needs no coordinator: remote ref updates are
  atomic compare-and-swap (`push --force-with-lease`) — prepare, push with
  lease, retry on a lost race.
- The **merge master** (already specced) is the kernel's maintainer role
  as an agent. At scale it generalizes to **path-scoped resident
  maintainer agents** — the roster gains a subsystems section mapping path
  patterns → resident agent + human owner. `MAINTAINERS` was accidentally
  a context-sharding scheme for agents: partition-by-subsystem answers
  scarce attention *and* scarce context.
- A **continuous integrator** resident (linux-next, per push instead of
  per day) merges in-flight branches and flags conflicts — semantic
  conflict watching is already in the merge master's job description.
- **Escalation is a first-class verdict** alongside approve /
  request-changes: "needs a human, here's why" — routed to the review
  inbox. Humans keep intent, invariants, the trust root, sampling audits,
  and taste; agents keep the pipeline.

## Verification and trust

- Checks are signed events from roster-listed runner keys; the committed
  policy says which runners count toward merge. CI stops being a forge
  feature and becomes "anyone trusted who did the work and signed it."
- Ceremony stops filtering once agents make it free, so the gate moves to
  **identity plus track record** — and agent track record is computable:
  every verdict is a signed record that reality later grades (did the
  approved change regress? did the green check hold?). **Calibration
  records** join outcomes back to the verdicts that predicted them;
  per-domain earned weight ("approvals count in `drivers/`, not `mm/`")
  feeds the merge policy. The kernel's trust-by-track-record, made
  queryable.

## Staging

1. **Native review** (specced) — threads, verdicts, round trip; SQLite;
   *records modeled as append-only events from day one*.
2. **Merge without the forge** (specced) — merge master, `merge_record`,
   git-first agents.
3. **Shared metadata** — event log under `refs/kanna/events/*`; SQLite
   becomes the materialized view; roster + SSH signing; relay liveness
   hints. Forge = dumb remote from here on.
4. **Team scale** — path-scoped residents, escalation verdicts,
   calibration records, policy-weighted merge. Postmaster/email gateway
   any time after 3.

## Risks, named

- The event-log rearchitecture is real work; the day-one modeling
  constraint in stage 1 is what keeps it mechanical.
- Sync latency needs the liveness plane; without relay or list, you
  degrade to polling freshness, never correctness.
- Key UX must stay zero-ceremony or it dies the web-of-trust death; the
  SSH piggyback is the design, not an optimization.
- Agent-scale contribution floods arrive dressed as quality work; the
  identity + calibration gate is load-bearing, not optional.
