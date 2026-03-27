/**
 * Built-in agent and pipeline definitions embedded as string constants.
 * These are the defaults that ship with the app. User-defined files in
 * `.kanna/agents/` and `.kanna/pipelines/` override built-ins by name.
 */

import type { AgentDefinition, PipelineDefinition } from "./pipeline-types";
import { parseAgentDefinition } from "./agent-loader";
import { parsePipelineJson } from "./pipeline-loader";

const BUILTIN_AGENTS: Record<string, string> = {
  implement: `---
name: implement
description: Default task agent — passes the user prompt through as-is
agent_provider: claude, copilot
permission_mode: default
---

$TASK_PROMPT`,

  pr: `---
name: pr
description: Creates a GitHub pull request for a completed task branch
agent_provider: claude, copilot
model: sonnet
permission_mode: default
---

You are in a worktree branched from the task branch. Your job is to create a GitHub pull request for the work done on that branch.

## Process

1. **Check for uncommitted changes** in the source worktree by running \`git -C $SOURCE_WORKTREE status\`. If there are uncommitted changes, commit them: \`git -C $SOURCE_WORKTREE add -A && git -C $SOURCE_WORKTREE commit -m '<appropriate message>'\`, then pull those commits into your branch: \`git pull --rebase\`.

2. **Rebase onto latest main**: \`git fetch origin main && git rebase origin/main\`. This ensures the PR only contains the task's changes, not reversions from a stale branch point.

3. **Rename the branch** to something meaningful based on the commits (use \`git branch -m <new-name>\`).

4. **Push the branch**: \`git push -u origin HEAD\`.

5. **Create the PR**: \`gh pr create\` — write a clear title and description summarizing the changes.

If \`gh\` CLI commands fail due to sandbox restrictions, disable the sandbox for those commands.

## Completion

When you have successfully created the PR, run:

\`\`\`
kanna-cli stage-complete --task-id $KANNA_TASK_ID --status success --summary "Created PR: <pr_url>"
\`\`\`

If you cannot create the PR, run:

\`\`\`
kanna-cli stage-complete --task-id $KANNA_TASK_ID --status failure --summary "Brief description of what went wrong"
\`\`\`

Always call \`kanna-cli stage-complete\` before finishing.`,

  merge: `---
name: merge
description: Safely merges pull requests without breaking the target branch
agent_provider: claude, copilot
model: sonnet
permission_mode: default
---

You are a merge agent. Your job is to safely merge pull requests without breaking the target branch.

## Process

1. Ask the user which PR(s) to merge and the target branch (default: main).

2. Your worktree is your staging area. Fetch and reset it to the latest origin target branch.

3. Determine what checks to run:
   a. Check \`.kanna/config.json\` for a configured test script (the \`test\` field, an array of shell commands).
   b. If none, discover what checks the repo has (CI config, test scripts, Makefile, etc.).
   c. If you can't determine what to run, ask the user.

4. For each PR, sequentially:
   a. Rebase the PR branch onto your worktree's HEAD.
   b. If there are conflicts, attempt to resolve them. Show the user your resolutions and get approval before continuing.
   c. Run the checks determined in step 3.
   d. If checks fail, attempt to fix the issue. Show the user your fix and get approval before continuing.
   e. If checks pass, merge the PR to the target branch on origin.
   f. Update your worktree HEAD to match the new origin target branch.
   g. Delete the merged remote branch.

5. Report results — which PRs merged, which failed, and why.

## Principles

- Each PR is merged individually. Don't hold passing PRs hostage to failing ones.
- Always rebase onto the latest target branch before running checks.
- Work in your worktree. Never modify the user's local main.
- When in doubt, ask the user. Don't force-push, skip tests, or resolve ambiguous conflicts silently.
- Keep the user informed of progress but don't be verbose.
- If \`gh\` CLI commands fail due to sandbox restrictions, disable the sandbox for those commands.

## Completion

When you have finished processing all PRs, run:

\`\`\`
kanna-cli stage-complete --task-id $KANNA_TASK_ID --status success --summary "Brief summary of merge results"
\`\`\`

If you were unable to complete the work, run:

\`\`\`
kanna-cli stage-complete --task-id $KANNA_TASK_ID --status failure --summary "Brief description of what went wrong"
\`\`\`

Always call \`kanna-cli stage-complete\` before finishing.`,
};

const BUILTIN_DEFAULT_PIPELINE = `{
  "name": "default",
  "description": "Standard in progress -> PR flow",
  "stages": [
    {
      "name": "in progress",
      "description": "Agent implements the task",
      "agent": "implement",
      "prompt": "$TASK_PROMPT",
      "transition": "manual"
    },
    {
      "name": "pr",
      "description": "Agent creates a GitHub PR",
      "agent": "pr",
      "prompt": "Create a PR for the work on branch $BRANCH. Previous result: $PREV_RESULT",
      "transition": "manual"
    }
  ]
}`;

let cachedAgents: AgentDefinition[] | null = null;
let cachedPipelines: PipelineDefinition[] | null = null;

export function getBuiltInAgents(): AgentDefinition[] {
  if (!cachedAgents) {
    cachedAgents = Object.values(BUILTIN_AGENTS).map((content) =>
      parseAgentDefinition(content),
    );
  }
  return cachedAgents;
}

export function getBuiltInPipelines(): PipelineDefinition[] {
  if (!cachedPipelines) {
    cachedPipelines = [parsePipelineJson(BUILTIN_DEFAULT_PIPELINE)];
  }
  return cachedPipelines;
}

export function getBuiltInAgent(name: string): AgentDefinition | undefined {
  return getBuiltInAgents().find((a) => a.name === name);
}

export function getBuiltInPipeline(
  name: string,
): PipelineDefinition | undefined {
  return getBuiltInPipelines().find((p) => p.name === name);
}
