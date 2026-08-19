# The Task Spec Artifact

A task's effective instructions are the original prompt **plus** every directive
delivered into the running session afterwards. Reviewers used to reconstruct
that from the stage prompt and, since the delivered-input ledger landed, from
`kanna_task_inputs`. Reconstruction diverges from reality as directives
accumulate — snippets are evidence that text arrived, not a statement of what
the task now means.

So the implementer writes the terms down. Each task carries one spec file,
committed on its branch with the work, and every reviewer judges the branch
against that file.

## The artifact

**Path:** `docs/task-specs/<task-id>.md` — one file per task, keyed by
`$KANNA_TASK_ID`, which is stable across every stage fork while branches and
worktrees are not. A repository whose conventions document names a different
location for it wins; there is exactly one per task either way.

**Contents:** goal, scope (what is in and what is deliberately out),
constraints, what makes the work done, and the mid-task directives that changed
any of those, each cited.

**Proportionality:** as short as the task allows. For a one-line fix a
three-line spec is a correct spec. What is required is that it exists, is true,
and is current — never that it is long. A reviewer that blocks a branch for a
terse spec has made the same mistake as one that blocks for the design it would
have chosen.

**Lifecycle:** created early in the implement stage, seeded from the task
prompt; updated in the same commit as the work whenever the terms change —
a mid-task directive, reviewer feedback, a human's decision during a revision,
or the implementer declining part of the task. The file's history is how the
contract got where it is; its current content is the contract.

## Why it is committed, and why it stays

The spec must be committed because **only committed work crosses a stage
boundary**: the review stage runs in a fresh worktree forked from the
implementer's committed tip, with a session that never saw the implementer's.
A file in the working tree would be invisible there. Committed, it arrives in
the review diff as an ordinary added or modified file, which also makes
staleness detectable — the reviewer sees the spec and the code change in the
same diff.

It then **survives into the merged PR**. Two alternatives were considered and
rejected:

- **`.kanna/task-specs/`.** Disqualified on a mechanism, not on taste: the
  definition snapshot reads `.kanna` recursively — one `git ls-tree -r` over
  the whole subtree followed by a batched read of *every blob it names*
  (`crates/kanna-server/src/task_creator/definition_source.rs`). An archive
  there would be listed and read into memory at every definition resolution, so
  the cost grows with the number of tasks the repository has ever run.
- **Dropping the file in the `pr` stage.** This keeps the default branch clean,
  but it puts a mandatory `git rm` plus commit into the most fragile agent in
  the system, ahead of its base-ref validation, rebase, and duplicate-PR
  detection — and it has to be repeated across every `pr` flavor, one of which
  (`push-only`) opens no PR to lift the spec into. A forgotten drop is silent.
  The cost of the machinery is paid on every task on a critical path; the cost
  of keeping the file is paid in disk.

Keeping it is not free, and the number is worth stating: this repository merged
242 pull requests in the 30 days before this convention landed, so
`docs/task-specs/` grows by roughly three thousand small markdown files a year.
That is contained rather than trivial — it is its own directory, deliberately
*not* mixed into `docs/specs/`, which holds curated design specs that people
read. It is also safely prunable in bulk at any time: the record it holds also
exists in the task branch (Kanna never deletes branches) and in the default
branch's history through the merge commit, so deleting the directory loses the
index, not the record.

## The reviewer contract

For the `review` and `qa-dispatcher` agents, and for every specialty reviewer a
dispatcher briefs:

1. **The spec is the statement of the task's terms.** Read it first; judge the
   branch against it rather than against a reconstruction of intent from the
   stage prompt.
2. **`kanna_task_inputs` is the audit trail behind it.** Use it to check the
   spec is honest: every directive the spec cites was really delivered, and no
   directive that changed the terms is missing from it.
3. **A disagreement between the two is a finding, not a licence.** A reviewer
   that believes the spec misstates a directive names both records and asks for
   the spec to be corrected. It does not silently substitute its own reading —
   that is the failure this convention exists to stop.
4. **A missing spec, or one the code has outgrown, is itself a finding.** The
   next reviewer will believe the spec; a stale one is worse than none.
5. **Length is never a finding.** See proportionality above.

The scope bar is unchanged. The spec says what the task means; it does not
widen what a reviewer may block on, and a reviewer cannot use it to import work
nobody asked for.

## Revisions

Revision feedback and human directives during a revision update the spec in the
same commit as the fix. The `Revision round N of M` preamble, the
`revision_limit` budget, and `request_revision` semantics are untouched by this
convention — see [qa-dispatch-review](qa-dispatch-review.md).

A revision resumes the implementer's previous session in its own worktree when
it can, so the same agent updates the same file; when it falls back to a fresh
fork, the committed spec is the incoming agent's statement of what the task
means, which is the point.

## What this deliberately does not change

No engine behavior. The spec is a convention carried by agent definitions:
`implement` writes and maintains it, `commit` commits it, `review` and
`qa-dispatcher` judge against it. Nothing in the server, the daemon, or the
stage engine knows the file exists, and no workflow JSON changed.

Follow-ups worth their own tasks, deliberately not built here:

- **Surfacing spec presence on task detail.** `kanna_get_task` could report
  whether the branch carries a spec and when it last changed, which would let a
  dispatcher notice a missing spec without a git read and let the desktop show
  it. That is an engine change and needs its own task.
- **Engine-enforced spec presence.** A stage post or transition check could
  refuse to advance a task whose branch has no spec. Worth considering only
  after the convention has run long enough to show whether agents keep it.

## Verification

The convention is pinned by content tests over the shipped definitions in
`packages/core/src/workflow/qa-assets.test.ts`: that all four agents name the
same path, that the implementer is told to seed and update it, that `commit`
carries it, and that both deciding reviewers judge against it while using the
input ledger as the audit trail.

There is no live-agent test that a real implement agent writes the file and a
real reviewer reads it. Such a test would need a full live implement → commit →
review round on a free provider, asserting on prose adherence rather than on a
CLI contract, which is neither cheap nor deterministic — the existing live lane
(`tests/cli-contract/tests/live/`) tests agent *CLI* contracts (flags,
transcripts, output shapes), not instruction-following. The deterministic part
of the risk — that the instruction reaches the agent at all — is covered by the
content tests, which read the definitions the server actually ships.
