import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { AGENT_PROVIDERS } from "@kanna/agent-protocol";
import { describe, expect, it } from "vitest";
import { parsePipelineJson } from "./pipeline-loader";

const repoRoot = resolve(process.cwd(), "../..");

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

/**
 * Agent prompts are hard-wrapped prose, so a phrase can straddle a newline.
 * Phrase assertions read the unwrapped text.
 */
function readRepoPhrases(path: string): string {
  return readRepoFile(path).replace(/\s+/g, " ");
}

describe("built-in agent completion protocol", () => {
  const agentNames = readdirSync(resolve(repoRoot, ".kanna/agents"));

  it.each(agentNames)("%s records stage completion MCP-first with a CLI fallback", (name) => {
    const agent = readRepoFile(`.kanna/agents/${name}/AGENT.md`);

    // The primary example must be the MCP tool call; the CLI form only
    // appears after it, as the no-MCP fallback.
    expect(agent).toContain('kanna_complete_stage {"task_id": "$KANNA_TASK_ID"');
    expect(agent.indexOf("kanna_complete_stage")).toBeLessThan(
      agent.indexOf("kanna-cli stage-complete")
    );
    if (name === "implement") {
      expect(agent).toContain("Follow the Kanna Task Environment completion instructions");
      expect(agent).not.toContain("This stage advances manually");
      expect(agent).not.toContain("do not record stage completion");
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
    const qaPipeline = readRepoFile(".kanna/pipelines/single-reviewer.json");

    expect(reviewAgent).toContain("You do not need to inspect the source task worktree");
    expect(reviewAgent).toContain("Do not make code, test, documentation, or configuration changes in the review worktree.");
    expect(reviewAgent).toContain("If the branch requires changes, request a revision back to the `in progress` stage.");
    expect(reviewAgent).toContain('--target-stage "in progress"');
    expect(reviewAgent).not.toContain("Make any fixes only in your current worktree");
    expect(qaPipeline).toContain("$BASE_REF");
    expect(qaPipeline).not.toContain("$SOURCE_WORKTREE");
  });

  it("ships the approve step as the pr stage's post instead of a legacy post_action", () => {
    const qaPipeline = readRepoFile(".kanna/pipelines/single-reviewer.json");
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

  it("holds every review agent to the same in-scope, blocking-only bar", () => {
    const reviewers = readdirSync(resolve(repoRoot, ".kanna/agents")).filter(
      (name) => name === "review" || name === "qa-dispatcher" || name.startsWith("review-")
    );
    // Guards the mechanism that turned scoped tasks into open-ended projects:
    // reviewers that keep finding new, out-of-scope work every round.
    expect(reviewers).toContain("review");
    expect(reviewers).toContain("qa-dispatcher");
    expect(reviewers).toContain("review-ui");

    for (const name of reviewers) {
      const agent = readRepoPhrases(`.kanna/agents/${name}/AGENT.md`);
      expect(agent, name).toContain("## Scope Discipline");
      expect(agent, name).toContain("caused by this diff");
      expect(agent, name).toContain("Follow-ups (non-blocking):");
      expect(agent, name).toContain("at most five blocking findings");
      // The bar is "did this diff break something", not "could this be
      // better" — a reviewer that blocks on the design it would have chosen
      // is how a scoped task turns into an open-ended project.
      expect(agent, name).toMatch(/design (you|a reviewer) would have chosen/);
    }
  });

  it("tells the deciding review agents that revision rounds are budgeted", () => {
    // Only the agents that can request a revision need to understand the
    // budget; specialty reviewers only record verdicts.
    for (const name of ["review", "qa-dispatcher"]) {
      const agent = readRepoPhrases(`.kanna/agents/${name}/AGENT.md`);
      expect(agent, name).toContain("revisionRounds");
      expect(agent, name).toContain("revisionLimit");
      expect(agent, name).toContain("parks the task for its human");
      expect(agent, name).toMatch(/do not retry the request/i);

      // The blocking bar must not move with the budget. Relaxing it on the
      // last round would approve a branch that still has blocking findings —
      // the designed ending for those is the park, where a human decides.
      expect(agent, name).toContain("The bar does not move with the budget");
      expect(agent, name).toContain("a finding that clears it on the last round");
      expect(agent, name).toContain("Do not approve a branch to avoid parking it");
      expect(agent, name).not.toMatch(/raise the bar as the budget shrinks/i);
      expect(agent, name).not.toMatch(/only for defects a user would hit/i);
      expect(agent, name).not.toMatch(/last (available )?round,? (fail|block) only/i);
      // A revision request must be a closed list, not an open invitation.
      expect(agent, name).toContain("closed list");
      expect(agent, name).toContain('No "also consider"');
    }
  });

  it("gates specialty dispatch on the surfaces the round actually changes", () => {
    const dispatcher = readRepoPhrases(".kanna/agents/qa-dispatcher/AGENT.md");

    // Relevance, not a headcount: the specialties have disjoint scopes, so a
    // change that touches several genuinely needs several reviewers. Scope is
    // held by the bar every reviewer works to and by the round budget.
    expect(dispatcher).toContain("Dispatch every specialty whose surface **this round's change** touches");
    expect(dispatcher).toContain("There is no cap");
    expect(dispatcher).toContain("Skip the specialties this round's change does not touch");
    expect(dispatcher).toContain("### 5. Filter the findings");
    expect(dispatcher).toContain("Do not create follow-up tasks");
  });

  it("names every dispatched child by its specialty and round", () => {
    const dispatcher = readRepoPhrases(".kanna/agents/qa-dispatcher/AGENT.md");

    // `display_name` is optional in the tool schema and falls back to the
    // prompt, and every child's prompt opens with the same dispatch line — so
    // a fan-out that omits it renders as a column of identical sidebar rows.
    expect(dispatcher).toContain('"display_name": "<Specialty> review: <subject> (round <n>)"');
    expect(dispatcher).toContain("Every dispatched child carries an explicit `display_name`");
    // A label per built-in specialty, so the rule is applicable and not just
    // aspirational; a repo-added reviewer derives its own.
    for (const label of [
      "| `review-ui` | `UI` |",
      "| `review-security` | `Security` |",
      "| `review-perf` | `Performance` |",
      "| `review-concurrency` | `Concurrency` |",
      "| `review-migration` | `Migration` |",
      "| `review-compat` | `Compatibility` |",
    ]) {
      expect(dispatcher, label).toContain(label);
    }
    expect(dispatcher).toContain("A repo-added `review-*` agent takes its label from its own `description`");
    // The round marker is what separates one round's children from the next's.
    expect(dispatcher).toContain("It is what tells this round's children from the previous round's");
    // The prompt snippet surfaces on its own (sidebar, mobile), so the first
    // line must be disambiguated too — not the old shared boilerplate.
    expect(dispatcher).toContain(
      '"prompt": "<Specialty> review (round <n>) dispatched from task $KANNA_TASK_ID.'
    );
    expect(dispatcher).not.toContain('"prompt": "Specialty review dispatched from task');
  });

  it("reviews each round incrementally against the previous round's workspace branch", () => {
    const dispatcher = readRepoPhrases(".kanna/agents/qa-dispatcher/AGENT.md");

    // Workspace branches are the round markers: a review workspace never
    // commits, so `task-{id}-{n}` still points at what that round reviewed.
    expect(dispatcher).toContain('git for-each-ref');
    expect(dispatcher).toContain("refs/heads/task-$KANNA_TASK_ID*");
    expect(dispatcher).toContain("git merge-base --is-ancestor");
    expect(dispatcher).toContain("previous review point");
    // Ancestry does not survive a rebase, so the rebased path must exist or
    // the mechanism silently no-ops on any repo that rebases mid-task.
    expect(dispatcher).toContain("git range-diff");
    expect(dispatcher).toContain("already reviewed");
    // Narrowing the range must fail safe, not silently under-review.
    expect(dispatcher).toContain("**Full branch** — if neither path is clear-cut");
    expect(dispatcher).toContain("If this round's change is empty, dispatch nothing");
    expect(dispatcher).toContain("$PREV_RESULT");
    // Children judge the round but read the whole branch for context.
    expect(dispatcher).toContain("Changes to review:");
    expect(dispatcher).toContain("Full branch context:");

    // The pipeline has to feed the dispatcher the previous stage result for
    // the declined-findings check to be possible at all.
    expect(readRepoFile(".kanna/pipelines/specialized-reviewers.json")).toContain("$PREV_RESULT");
  });

  it("tells specialty reviewers to judge the review range their prompt names", () => {
    const specialties = readdirSync(resolve(repoRoot, ".kanna/agents")).filter((name) =>
      name.startsWith("review-")
    );
    expect(specialties.length).toBeGreaterThan(0);

    for (const name of specialties) {
      const agent = readRepoPhrases(`.kanna/agents/${name}/AGENT.md`);
      expect(agent, name).toContain("Judge the review range your prompt names");
      expect(agent, name).toContain("what changed since the last review round");
      expect(agent, name).toContain("Read the full branch");
    }
  });

  it("keeps the implement agent inside the task's scope on revisions", () => {
    const implement = readRepoPhrases(".kanna/agents/implement/AGENT.md");

    expect(implement).toContain("Do not widen the task");
    expect(implement).toContain("the reviewer's feedback is the whole assignment");
  });

  it("bounds revision rounds on the dispatched QA pipeline and publishes the field", () => {
    const parsed = parsePipelineJson(readRepoFile(".kanna/pipelines/specialized-reviewers.json"));
    expect(parsed.revision_limit).toBe(3);

    const schema = JSON.parse(readRepoFile(".kanna/pipelines/schema.json"));
    expect(schema.properties.revision_limit).toMatchObject({ type: "integer", minimum: 0 });
  });

  it("resolves PR head/base refs with gh pr view even when task metadata has the URL", () => {
    const approveAgent = readRepoPhrases(".kanna/agents/approve/AGENT.md");
    const approveContract = readRepoPhrases(".kanna/agents/approve/CONTRACT.md");

    // The MERGE line is built from headRefName/baseRefName, which task
    // metadata never carries — it only has prUrl. Taking the metadata path
    // and skipping `gh pr view` leaves both refs unresolved.
    expect(approveAgent).toContain("gh pr view <prUrl-or-$BRANCH> --json url,isDraft,baseRefName,headRefName,title");
    expect(approveAgent).toContain("Run it even when task context already gave you `prUrl`");
    expect(approveAgent).toContain("If no PR resolves");
    expect(approveContract).toContain("including when task metadata already carried `prUrl`");
    expect(approveContract).toMatch(/headRefName.*baseRefName/);
  });

  it("does not build flipping draft PRs ready into the stock approve post", () => {
    // The stock flow opens an ordinary PR, so approve never meets a draft and
    // stays out of PR state entirely. Drafts exist only through the opt-in
    // pr@draft-pr flavor, and a repo choosing it owns what readies them
    // (approve/EXTEND.md) — which is why merge@github refuses to run a bare
    // `gh pr merge` on one.
    expect(readRepoPhrases(".kanna/agents/approve/AGENT.md")).not.toContain("gh pr ready");
    expect(readRepoPhrases(".kanna/agents/approve/CONTRACT.md")).not.toContain("gh pr ready");
    expect(readRepoPhrases(".kanna/agents/setup/AGENT.md")).not.toContain("mark this PR ready");
    expect(readRepoPhrases(".kanna/agents/merge/flavors/github/AGENT.md")).toContain(
      "GitHub refuses this while a PR is still a draft",
    );
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
