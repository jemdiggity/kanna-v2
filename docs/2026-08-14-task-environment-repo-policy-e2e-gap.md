# Task-environment repository-policy E2E gap (2026-08-14)

Kanna's universal task-environment prompt crosses definition resolution,
stage prompt composition, PTY or SDK spawn preparation, the daemon protocol,
and finally the selected agent CLI. The repository's own `AGENTS.md` is then
loaded by the agent CLI, outside Kanna's prompt composer. This change removes
the Kanna staging/production identity rule from the universal prompt while
retaining it in Kanna's root `AGENTS.md` and ship agent definition.

The automated coverage stops at the daemon command boundary. Server tests
prepare real temporary repositories and worktrees and inspect commands sent to
a fake daemon for PTY, SDK, stage-transition, revision, post-fallback, resume,
and transferred-task paths. TypeScript contracts render an ordinary repository
prompt without the rule and a Kanna ship prompt with the repo-scoped rule.

A true process E2E would launch each supported authenticated provider CLI in
an isolated temporary repository, capture its effective system and repository
instructions, and prove both that an ordinary repository never sees the Kanna
runtime-identity rule and that the Kanna repository's root `AGENTS.md` remains
authoritative. The existing live CLI suites consume credentials and quota and
do not expose a provider-neutral way to inspect the fully assembled instruction
stack, so adding such a test today would either be provider-specific or infer
the prompt from model output. Close this gap when the CLI contract harness can
capture effective instructions deterministically without sending a model turn.
