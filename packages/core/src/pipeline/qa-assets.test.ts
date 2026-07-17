import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { AGENT_PROVIDERS } from "@kanna/agent-protocol";
import { describe, expect, it } from "vitest";
import { parsePipelineJson } from "./pipeline-loader";

const repoRoot = resolve(process.cwd(), "../..");

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

describe("built-in agent completion protocol", () => {
  const agentNames = readdirSync(resolve(repoRoot, ".kanna/agents"));

  // The implement agent runs on manual-transition `in progress` stages: the
  // user reviews the work and advances the pipeline, so recording success is
  // meaningless there and the agent must not be told to do it.
  const manualStageAgents = new Set(["implement"]);

  it.each(agentNames)("%s records stage completion MCP-first with a CLI fallback", (name) => {
    const agent = readRepoFile(`.kanna/agents/${name}/AGENT.md`);

    // The primary example must be the MCP tool call; the CLI form only
    // appears after it, as the no-MCP fallback.
    expect(agent).toContain('kanna_complete_stage {"task_id": "$KANNA_TASK_ID"');
    expect(agent.indexOf("kanna_complete_stage")).toBeLessThan(
      agent.indexOf("kanna-cli stage-complete")
    );
    if (manualStageAgents.has(name)) {
      expect(agent).toContain("do not record stage completion");
      expect(agent).not.toContain("--status success");
      expect(agent).not.toContain('"status": "success"');
    } else {
      expect(agent).toContain(
        'kanna_complete_stage {"task_id": "$KANNA_TASK_ID", "status": "success"'
      );
      expect(agent).toContain(
        'kanna-cli stage-complete --task-id "$KANNA_TASK_ID" --status success'
      );
    }
    // Every agent needs an explicit non-success path: failure completion or a revision request.
    expect(
      agent.includes("--status failure") || agent.includes("kanna_request_revision")
    ).toBe(true);
    // The task id must stay quoted in CLI examples.
    expect(agent).not.toContain("--task-id $KANNA_TASK_ID");
  });
});

describe("QA pipeline assets", () => {
  it("keeps the pipeline provider schema aligned with the generated registry", () => {
    const schema = JSON.parse(readRepoFile(".kanna/pipelines/schema.json")) as {
      $defs?: { agentProvider?: { enum?: string[] } };
    };

    expect(schema.$defs?.agentProvider?.enum).toEqual([...AGENT_PROVIDERS]);
  });

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

  it("ships the approve step as the pr stage's post instead of a legacy post_action", () => {
    const qaPipeline = readRepoFile(".kanna/pipelines/qa.json");
    // Legacy `post_action` still compiles at load time for pinned
    // pipeline_def snapshots, but shipped assets must use the current format.
    expect(qaPipeline).not.toContain("post_action");
    expect(readRepoFile(".kanna/pipelines/schema.json")).not.toContain("post_action");

    const parsed = parsePipelineJson(qaPipeline);
    const prStage = parsed.stages.find((stage) => stage.name === "pr");
    expect(prStage?.post?.name).toBe("approve");
    expect(prStage?.post?.agent).toBe("approve");
    expect(prStage?.post?.prompt).toContain("$PREV_RESULT");
  });

  it("ships the approve post on the default pipeline pr stage so advancing queues the merge", () => {
    const parsed = parsePipelineJson(readRepoFile(".kanna/pipelines/default.json"));
    const prStage = parsed.stages.find((stage) => stage.name === "pr");
    expect(prStage?.post?.name).toBe("approve");
    expect(prStage?.post?.agent).toBe("approve");
    expect(prStage?.post?.prompt).toContain("$PREV_RESULT");
  });

  it("automates default implement revisions without automating the initial handoff", () => {
    const parsed = parsePipelineJson(readRepoFile(".kanna/pipelines/default.json"));
    const implement = parsed.stages.find((stage) => stage.name === "in progress");

    expect(implement?.policy).toEqual({
      transition: "manual",
      revision_transition: "auto",
    });
  });

  it("publishes revision transition values in the pipeline schema", () => {
    const schema = JSON.parse(readRepoFile(".kanna/pipelines/schema.json"));
    const revisionTransition =
      schema.properties.stages.items.properties.policy
        .properties.revision_transition;

    expect(revisionTransition.enum).toEqual(["manual", "auto"]);
  });

  it("keeps the PR agent agnostic to the development branch name", () => {
    const prAgent = readRepoFile(".kanna/agents/pr/AGENT.md");

    expect(prAgent).toContain("$BASE_REF");
    expect(prAgent).not.toContain("latest main");
    expect(prAgent).not.toContain("origin/main");
  });

  it("keeps the merge master git-first and safe for stacked branches", () => {
    const mergeAgent = readRepoFile(".kanna/agents/merge/AGENT.md");
    const approveAgent = readRepoFile(".kanna/agents/approve/AGENT.md");

    expect(mergeAgent).toContain("PR metadata can explain intent, but topology decides ordering.");
    expect(mergeAgent).toContain("Do not infer stack relationships from PR titles or descriptions");
    expect(mergeAgent).toContain("Do not delete a parent branch while an unmerged child still uses it");
    expect(approveAgent).toContain("MERGE <branch> -> <target> [TASK <task_id>] [PR <url>]: <summary>");
    expect(mergeAgent).toContain("MERGE <branch> -> <target> [TASK <task_id>] [PR <url>]: <summary>");
    expect(mergeAgent).toContain("Before deleting any merged remote branch, call `kanna_is_dependent_tasks_exist` with the merged task id");
    expect(mergeAgent).toContain("If it returns `exists: true`, do not delete the remote branch");
    expect(mergeAgent).toContain('If MCP is unavailable, use `kanna-cli task dependent-tasks-exist --task-id "<task_id>"`.');
    expect(mergeAgent).not.toContain("If MCP is unavailable, use `curl ");
    expect(mergeAgent).toContain("A blocker that has reached `pr` can already have dependent tasks stacked on its branch");
    expect(mergeAgent).toContain("After the full detected stack has merged, delete the stack branches that are no longer needed");
    expect(mergeAgent).toContain("gh pr merge <PR> --merge");
    expect(mergeAgent).toContain("Do not push directly to the target branch.");
    expect(mergeAgent).not.toContain("--delete-branch");
  });
});
