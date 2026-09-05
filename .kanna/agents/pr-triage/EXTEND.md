## Kanna Repository Review Scope

The built-in `pr-triage` agent deliberately leaves review scope undefined and
asks for it. In this repository it is already answered: **review every open pull
request on the repo, whoever or whatever opened it** — Kanna task branches,
hand-authored branches, and dependency bumps alike.

So do not ask the scope question here. Triage the full open list.

Two consequences worth carrying into the proposed order, both specific to how
this repository works:

- **Kanna's own task PRs are the common case, and they carry their terms with
  them.** A PR whose body has a `Kanna-Task:` trailer has a task spec at
  `docs/task-specs/<task-id>.md` on its branch, and a run history reachable
  with `kanna_get_task` and `kanna_task_inputs`. Say so when you propose the
  order, and pass the task id to the child so its reviewer reads the spec
  instead of reconstructing intent from the diff.
- **This is a distributed system that ships as one signed app**, so the blast
  radius of a change is not proportional to its size. Rank PRs touching the
  daemon handoff contract, the server boundary, the DB schema and migrations,
  the relay and mobile wire formats, agent and workflow definitions, or the
  release and signing path above larger PRs confined to one component. The
  repository's own `AGENTS.md`/`CLAUDE.md` is the authority on which of these
  are load-bearing; read it before ranking, not after.

> Inert until the built-in `pr-triage` agent ships (phase 1 of
> `docs/specs/pr-review-dispatch.md`). An `EXTEND.md` whose base agent does not
> resolve is skipped, so this file changes nothing until then — it is
> deliberately committed ahead of the agent as the worked example of the
> extension path the setup agent is meant to write.
