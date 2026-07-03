import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(process.cwd(), "../..");

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

describe("QA pipeline assets", () => {
  it("keeps the commit agent focused on committing work instead of task-session mechanics", () => {
    const commitAgent = readRepoFile(".kanna/agents/commit/AGENT.md");

    expect(commitAgent).toContain("Your job is to commit the relevant changes before PR creation");
    // Success is judged on TASK-RELATED changes only: pre-existing untracked
    // files (workspace scaffolding, editor droppings) must not block the
    // commit verdict.
    expect(commitAgent).toContain("Report success once every TASK-RELATED change is committed");
    expect(commitAgent).toContain("do not block success");
    expect(commitAgent).not.toContain("same Kanna task session");
  });

  it("instructs the QA agent to request revision instead of changing the review branch", () => {
    const reviewAgent = readRepoFile(".kanna/agents/review/AGENT.md");
    const qaPipeline = readRepoFile(".kanna/pipelines/qa.json");

    expect(reviewAgent).toContain("You do not need to inspect the source task worktree");
    expect(reviewAgent).toContain("Do not make code, test, documentation, or configuration changes in the review worktree.");
    expect(reviewAgent).toContain("If the branch requires changes, request a revision back to the `in progress` stage.");
    expect(reviewAgent).toContain('--target-stage "in progress"');
    expect(reviewAgent).not.toContain("Make any fixes only in your current worktree");
    expect(qaPipeline).toContain("$BASE_REF");
    expect(qaPipeline).not.toContain("$SOURCE_WORKTREE");
  });

  it("keeps the PR agent agnostic to the development branch name", () => {
    const prAgent = readRepoFile(".kanna/agents/pr/AGENT.md");

    expect(prAgent).toContain("$BASE_REF");
    expect(prAgent).not.toContain("latest main");
    expect(prAgent).not.toContain("origin/main");
  });

  it("keeps stacked PR base branches until the full stack is merged", () => {
    const mergeAgent = readRepoFile(".kanna/agents/merge/AGENT.md");

    expect(mergeAgent).toContain("Inspect each PR's title, description, head branch, and base branch");
    expect(mergeAgent).toContain("Do not delete a PR branch while any unmerged PR still uses it as its base");
    expect(mergeAgent).toContain("After the full detected stack has merged, delete the stack branches that are no longer needed");
    expect(mergeAgent).toContain("gh pr merge <PR_NUMBER> --merge");
    expect(mergeAgent).not.toContain("gh pr merge <PR_NUMBER> --merge --delete-branch");
  });
});
