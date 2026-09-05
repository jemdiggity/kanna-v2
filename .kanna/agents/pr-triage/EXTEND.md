## Kanna Repository Review Scope

The built-in `pr-triage` agent deliberately leaves review scope undefined and
asks for it. In this repository it is already answered: **review every open pull
request on the repo, whoever or whatever opened it** — Kanna task branches,
hand-authored branches, and dependency bumps alike.

So do not ask the scope question here. Triage the full open list.

Two consequences worth carrying into the proposed order, both specific to how
this repository works:

- **Kanna's own task PRs are the common case, and they carry their terms with
  them.** A PR whose body has a `Kanna-Task:` trailer has a durable record
  reachable with `kanna_get_task` and `kanna_task_inputs` — the original prompt
  plus every directive delivered during the task (pass `machine_id` when the
  task lives on another machine). Say so when you propose the order, and pass
  the task id to the child so its reviewer reads that record instead of
  reconstructing intent from the diff. There is no committed task-spec file to
  look for: this repository retired that convention, so a trailer with no such
  document is the normal, current shape.
- **This is a distributed system that ships as one signed app**, so the blast
  radius of a change is not proportional to its size. Rank PRs touching the
  daemon handoff contract, the server boundary, the DB schema and migrations,
  the relay and mobile wire formats, agent and workflow definitions, or the
  release and signing path above larger PRs confined to one component. The
  repository's own `AGENTS.md`/`CLAUDE.md` is the authority on which of these
  are load-bearing; read it before ranking, not after.
