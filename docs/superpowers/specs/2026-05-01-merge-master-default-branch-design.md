# Merge Master Default Branch Design

## Goal

Merge Master should default to the selected repo's real development branch instead of assuming `main`.

## Current Behavior

The desktop store starts Merge Master by loading the `merge` agent definition and passing its prompt directly to task creation. The merge agent prompt currently tells the agent to ask for a target branch with `main` as the default. Repos already store `default_branch`, and normal task creation already resolves `base_ref` from Git branch metadata.

## Design

When `mergeQueue()` starts a merge agent, it will append a small runtime context block to the merge agent prompt. The block will name the repo default branch and tell the agent to treat it as the default target branch for this run.

The merge agent instructions will stop hard-coding `main`. They will instead use the runtime target branch context when present and verify it against Git remote metadata before merging. If runtime context is missing, the agent should check `origin/HEAD` or `git remote show origin` to infer the default branch.

## Data Flow

1. User starts Merge Master for the selected repo.
2. Store finds the selected `repo` row.
3. Store loads `.kanna/agents/merge/AGENT.md` through the existing workflow agent loader.
4. Store appends runtime context containing `repo.default_branch || "main"`.
5. Store creates the merge task with the augmented prompt.
6. Merge agent uses the provided branch as the default target and verifies it before merging.

## Error Handling

If the repo row has no default branch, the store falls back to `main`, matching existing behavior. If the agent's verification disagrees with the provided branch, the agent asks the user before proceeding.

## Testing

Add a focused store regression test that sets a repo's `default_branch` to `dev`, starts Merge Master, and asserts the created task prompt contains `dev` as the target branch context.
