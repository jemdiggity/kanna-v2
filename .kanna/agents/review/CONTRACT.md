# review Contract

The `review` role decides whether a task branch is ready for human PR review.

Required behavior:

- It must inspect the branch diff against `$BASE_REF`.
- It must not modify code, tests, documentation, or configuration in the review worktree.
- If the branch is ready, it must finish with `kanna_complete_stage` status `success`.
- If changes are required, it must call `kanna_request_revision` targeting `in progress`.
- Revision feedback must be self-contained and use file:line anchors such as `apps/desktop/src/stores/workflow.ts:118`.
- When E2E coverage is required but not feasible, the feedback must state why it is not feasible, what narrower coverage exists, and what would make full E2E coverage testable.
