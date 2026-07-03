import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(process.cwd(), "../..");

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

describe("built-in agent completion protocol", () => {
  const agentNames = readdirSync(resolve(repoRoot, ".kanna/agents"));

  it.each(agentNames)("%s records stage completion MCP-first with a CLI fallback", (name) => {
    const agent = readRepoFile(`.kanna/agents/${name}/AGENT.md`);

    expect(agent).toContain("kanna_complete_stage");
    expect(agent).toContain('kanna-cli stage-complete --task-id "$KANNA_TASK_ID" --status success');
    // Every agent needs an explicit non-success path: failure completion or a revision request.
    expect(
      agent.includes("--status failure") || agent.includes("kanna_request_revision")
    ).toBe(true);
    // The task id must stay quoted in CLI examples.
    expect(agent).not.toContain("--task-id $KANNA_TASK_ID");
  });
});

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

  it("keeps the merge master git-first and safe for stacked branches", () => {
    const mergeAgent = readRepoFile(".kanna/agents/merge/AGENT.md");

    expect(mergeAgent).toContain("PR metadata can explain intent, but topology decides ordering.");
    expect(mergeAgent).toContain("Do not delete a parent branch while an unmerged child still uses it");
    expect(mergeAgent).toContain("gh pr merge <PR> --merge");
    expect(mergeAgent).toContain("Do not push directly to the target branch.");
    expect(mergeAgent).not.toContain("--delete-branch");
  });
});
