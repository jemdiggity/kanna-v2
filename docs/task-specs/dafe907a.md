# Task dafe907a: preserve merged branches and escalate exhausted revisions

## Owner directives (2026-08-26)

> "let's improve the merge agent's instructions. we currently tell it to delete the branch. let's remove that instruction. it causes more pita than anything else."

> "I think the revise issue is getting overly complicated. we can just have the agent instructions instruct the agent to ask a human before doing another set of reviews."

## Terms

- Update the merge agent, its contract, and its Git/GitHub flavors so merged branches are explicitly left in place, stacked children are still retargeted to a live parent or target, and merge commands never request branch deletion.
- Update the review, QA-dispatcher, and task-manager definitions so an exhausted revision budget causes an explicit human escalation and a stop: agents must not retry, approve to avoid parking, continue review rounds, or invent/relay an override. The human uses the desktop revision action, whose `origin: "human"` path resets the budget.
- Definition text only. Do not change server code, the tool catalog, revision-budget behavior, or add an authorization-relay mechanism. Pure instruction changes require no E2E test or coverage-gap note.

Done means all affected definitions state these rules explicitly and the repository's applicable definition/bundled-resource checks pass; `./kd test all` remains unaffected.

## Context (evidence, not scope)

On 2026-08-25, phase 2 branch `feat/anonymous-push-pairing-certificates` was deleted after PR #1230 merged despite the dependent-task guard. Phase 3 task `bbe96646`, stacked on that branch, then could not create its PR until a human retargeted it. PR #1236 for task `73363a4c` attempted attributed relayed authorization after budget exhaustion; the owner closed it unmerged in favor of instruction-level human escalation.
