import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { AGENT_PROVIDERS } from "@kanna/agent-protocol";
import { describe, expect, it } from "vitest";
import {
  applyAgentExtension,
  parseAgentDefinition,
  parseAgentExtension,
} from "./agent-loader";
import {
  buildKannaRuntimeUserPrompt,
  buildStagePrompt,
} from "./prompt-builder";
import { parseWorkflowJson } from "./workflow-loader";

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

/**
 * Directory names under `.kanna/agents` that actually define a built-in agent.
 * A directory may hold only a repo-local `EXTEND.md` — an answer this
 * repository gives to a built-in that ships elsewhere, or to one that has not
 * shipped yet — and that is an extension, not a built-in agent definition.
 */
function builtInAgentNames(): string[] {
  return readdirSync(resolve(repoRoot, ".kanna/agents"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(resolve(repoRoot, `.kanna/agents/${name}/AGENT.md`)))
    .sort();
}

describe("built-in agent completion protocol", () => {
  const agentNames = builtInAgentNames();

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

describe("built-in agent tool references", () => {
  /**
   * Agent bodies name MCP tools as literal `kanna_*` calls, and a name that
   * does not exist in the catalog is a call the agent can never make — a
   * failure a human only sees when the agent tries it mid-task.
   */
  it("only names tools the tool catalog serves", () => {
    const catalog = readRepoFile("crates/kanna-tool-catalog/src/catalog.json");
    const served = new Set(
      Array.from(catalog.matchAll(/"name":\s*"(kanna_[a-z_]+)"/g), (match) => match[1])
    );
    expect(served.size).toBeGreaterThan(0);

    const documents = [
      ...builtInAgentNames().map((name) => `.kanna/agents/${name}/AGENT.md`),
      ...readdirSync(resolve(repoRoot, ".kanna/agents"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `.kanna/agents/${entry.name}/EXTEND.md`)
        .filter((path) => existsSync(resolve(repoRoot, path))),
    ];

    for (const path of documents) {
      const referenced = new Set(
        Array.from(readRepoFile(path).matchAll(/\bkanna_[a-z_]+/g), (match) => match[0])
      );
      const unknown = [...referenced].filter((name) => !served.has(name)).sort();
      expect(unknown, path).toEqual([]);
    }
  });
});

describe("QA workflow assets", () => {
  it("keeps process termination guidance in repository conventions", () => {
    const builtInAgents = builtInAgentNames();
    expect(builtInAgents.length).toBeGreaterThan(0);

    for (const name of builtInAgents) {
      const agent = readRepoPhrases(`.kanna/agents/${name}/AGENT.md`);
      expect(agent, name).not.toContain("pkill");
      expect(agent, name).not.toContain("killall");
    }

    const conventions = readRepoPhrases("AGENTS.md");
    expect(conventions).toContain("Never use `pkill -f` or `killall`");
    expect(conventions).toContain("Kanna task prompts are present in agent argv");
  });

  it("keeps Kanna runtime identity policy repo-scoped", () => {
    const ordinaryPrompt = buildKannaRuntimeUserPrompt(
      buildStagePrompt("Implement the task.", "$TASK_PROMPT", {
        taskPrompt: "Fix the imported repository.",
      })
    );
    const kannaAgents = readRepoPhrases("AGENTS.md");
    const ship = applyAgentExtension(
      parseAgentDefinition(readRepoFile(".kanna/agents/ship/AGENT.md")),
      parseAgentExtension(readRepoFile(".kanna/agents/ship/EXTEND.md")),
    );
    const kannaShipPrompt = buildKannaRuntimeUserPrompt(
      buildStagePrompt(ship.prompt, "$TASK_PROMPT", {
        taskPrompt: "Publish the authorized staging release.",
      })
    );

    expect(ordinaryPrompt).not.toContain("kanna_info");
    expect(ordinaryPrompt).not.toContain("kanna-cli info");
    expect(ordinaryPrompt).not.toContain("authoritative server environment");
    expect(kannaAgents).toContain(
      "Before debugging or performing environment-sensitive operations against a running instance"
    );
    expect(kannaAgents).toContain("mobile notifications, cloud deploys, mobile OTA publishes");
    expect(kannaAgents).toContain("direct local/LAN API calls), call `kanna_info`");
    expect(kannaShipPrompt).toContain("Call `kanna_info`");
    expect(kannaShipPrompt).toContain("authoritative server environment/version");
    expect(kannaShipPrompt.match(/`kanna_info`/g)).toHaveLength(1);
  });

  // TEMPORARY, paired with the wildcard flip in `.kanna/config.json`: the codex
  // CLI ran out of account credits on 2026-08-07, and because agent definitions
  // resolve from origin/main at every spawn, a codex-first wildcard sent every
  // review, qa-dispatcher, pr, and approve agent to a CLI that could not run.
  // Restore condition: when codex credits reset (2026-08-08 12:34 PM) and the
  // config is reordered back, flip this expectation with it — the assertion and
  // the config are one decision recorded in two files, so they move together.
  it("prefers Claude for every Kanna role without changing other repos' built-in order", () => {
    const config = JSON.parse(readRepoFile(".kanna/config.json")) as {
      agentProviders?: Record<string, { provider?: unknown } | string>;
    };
    const claudeFirst = ["claude", "codex", "copilot", "opencode", "antigravity"];

    expect(config.agentProviders?.["*"]).toEqual({ provider: claudeFirst });
    for (const [pattern, preference] of Object.entries(config.agentProviders ?? {})) {
      const provider = typeof preference === "string" ? preference : preference.provider;
      const firstProvider = Array.isArray(provider) ? provider[0] : provider;
      expect(firstProvider, pattern).toBe("claude");
    }

    for (const name of [
      "implement",
      "commit",
      "pr",
      "approve",
      "merge",
      "setup",
      "agent-factory",
      "config-factory",
      "workflow-factory",
    ]) {
      const agent = parseAgentDefinition(readRepoFile(`.kanna/agents/${name}/AGENT.md`));
      expect(agent.agent_provider?.[0], name).toBe("claude");
    }

    // The repo wildcard is the only lever; the shipped definitions stay as they
    // are, which is what preserves behavior for repositories without the key.
    // These assertions are unchanged by the temporary flip above — they pinned
    // claude before it and still do — so they keep proving the wildcard is what
    // moves, not the built-ins.
    for (const name of [
      "review",
      "qa-dispatcher",
      "review-ui",
      "review-security",
      "review-perf",
      "review-concurrency",
      "review-migration",
      "review-compat",
      "review-release",
    ]) {
      const agent = parseAgentDefinition(readRepoFile(`.kanna/agents/${name}/AGENT.md`));
      expect(agent.agent_provider?.[0], name).toBe("claude");
    }
  });

  it("ships Task Manager as a Codex-first singleton palette task", () => {
    const agent = parseAgentDefinition(readRepoFile(".kanna/agents/task-manager/AGENT.md"));
    const task = readRepoFile(".kanna/tasks/task-manager/agent.md");

    expect(agent.name).toBe("task-manager");
    expect(agent.agent_provider?.[0]).toBe("codex");
    expect(agent.prompt).toContain("kanna_wait_events");
    expect(agent.prompt).toContain("Scope the watch to the whole repository");
    expect(agent.prompt).toContain("kanna-cli task watch --repo-id <repo-id>");
    expect(agent.prompt).toContain("starts at the live tail without replaying history");
    expect(agent.prompt).toContain(
      "reconcile every open task's current state, including blocked tasks with no session yet"
    );
    expect(agent.prompt).toContain(
      "Do not hand-roll shell/Python wrappers around `kanna_wait_events`"
    );
    expect(agent.prompt).toContain("A wake means “drain the feed,”");
    expect(agent.prompt).toContain("immediately re-arm the command with `--cursor");
    expect(agent.prompt).toContain("task.runtime_changed");
    expect(agent.prompt).toContain("`task.blocked` / `task.unblocked`");
    expect(agent.prompt).toContain("task.runtime_settled");
    expect(agent.prompt).toContain("task.awaiting_advance");
    expect(agent.prompt).toContain("Notify Human Blockers");
    expect(agent.prompt).toContain(
      "Call `kanna_notify_mobile` whenever coordination transitions into a blocker only a human can clear"
    );
    expect(agent.prompt).toContain("`task_id` so tapping the notification opens that task");
    expect(agent.prompt).toContain("one notification per distinct blocking condition");
    expect(agent.prompt).toContain(
      "identify the task by short human-readable name and id, state what is blocked and why"
    );
    expect(agent.prompt).toContain(
      "Never claim the human was notified when the response says otherwise"
    );
    expect(agent.prompt).toContain("an absent or zero `lanDeliveredCount` is expected");
    expect(agent.prompt).toContain("ask the human to use the desktop revision action");
    expect(agent.prompt).toContain('origin: "human"');
    expect(agent.prompt).toContain("coordinate another set of reviews");
    expect(agent.prompt).toContain("the event loop is idle by design while awaiting human action");
    expect(agent.prompt).toContain("Observe completion only through the MCP wait surfaces");
    expect(agent.prompt).toContain(
      "Product work, bug fixes, investigations, releases, and other durable repository tasks"
    );
    expect(agent.prompt).not.toContain('"notify_task_id"');
    expect(agent.prompt).toContain("Do not set `parent_task_id`");
    expect(agent.prompt).toContain("The long-running manager is never a parent/owner bucket");
    expect(agent.prompt).toContain('"parent_task_id": "<durable-work-item-id>"');
    expect(agent.prompt).toContain("purpose-built child workflows");
    expect(agent.prompt).toContain("latestRun");
    expect(agent.prompt).toContain("Audit Premise, Scope, And Runaway Work");
    expect(agent.prompt).toContain("ask the agent for one concise re-report");
    expect(agent.prompt).toContain("HOLD implementation and merge handoff");
    expect(agent.prompt).toContain("independent, bounded, on-demand architect consultation");
    expect(agent.prompt).toContain('"workflow_name": "architect-consultation"');
    expect(agent.prompt).toContain('"base_ref": "<assessed-work-item-branch>"');
    expect(agent.prompt).toContain(
      '"parent_task_id": "<assessed-durable-work-item-id>"'
    );
    expect(agent.prompt).toContain("Do not add an `agent` override");
    expect(agent.prompt).toContain("singleton/perpetual architect");
    expect(agent.prompt).toContain("consultation's `latestRun.summary`");
    expect(agent.prompt).toContain(
      "The manager remains accountable for scope, dependencies, budgets, holds, review coverage, and merge handoff"
    );
    expect(agent.prompt).toContain(
      "Kanna's current task and log surfaces do not expose a reliable universal token counter"
    );
    expect(agent.prompt).toContain("Preserve branches and commits when retiring the old work");
    expect(agent.prompt).toContain("Resolve the authoritative remote default-branch tip");
    expect(agent.prompt).toContain("A bare local branch name is a possibly stale pointer");
    expect(agent.prompt).toContain(
      "short human-readable name or purpose followed by its id in parentheses"
    );
    expect(agent.prompt).toContain("Never make a human decode a bare task id");
    expect(agent.prompt).toContain(
      "Name pull requests the same way—a brief description of what the PR changes followed by its number"
    );
    expect(agent.prompt).toContain("Watch Machine Capacity Before Starting Heavy Work");
    expect(agent.prompt).toContain("Use `kanna_machine_stats`");
    expect(agent.prompt).toContain(
      "For an older server that does not advertise `kanna_machine_stats`"
    );
    expect(agent.prompt).toContain("`sysctl -n hw.logicalcpu`");
    expect(agent.prompt).toContain(
      "`ps -axo pcpu,command` filtered for `rustc`, `cargo`, `bazel`, `vitest`, `xcodebuild`, and Node test runners"
    );
    expect(agent.prompt).toContain(
      "`kanna_list_recent_tasks` with `all_machines: true`"
    );
    expect(agent.prompt).toContain(
      "group open rows by `machineId`, and count `runtimeState: \"busy\"`"
    );
    expect(agent.prompt).toContain("this sees sessions, not build processes");
    expect(agent.prompt).toContain("`kanna_task_logs` tail");
    expect(agent.prompt).toContain("roughly two concurrent full gates per machine");
    expect(agent.prompt).toContain("unknown capacity, never idle capacity");
    expect(agent.prompt).toContain(
      "Put an explicit pause-heavy-verification directive in the creation prompt"
    );
    expect(agent.prompt).toContain(
      "a paused task nobody resumed is a task you parked by accident"
    );
    expect(agent.prompt).toContain(
      "there is no scheduler or admission control behind them"
    );
    expect(task).toContain("name: Task Manager");
    expect(task).toContain("agent: task-manager");
  });

  it("keeps genuine QA fan-out children parented to their dispatcher", () => {
    const dispatcher = parseAgentDefinition(readRepoFile(".kanna/agents/qa-dispatcher/AGENT.md"));

    expect(dispatcher.prompt).toContain('"parent_task_id": "$KANNA_TASK_ID"');
    expect(dispatcher.prompt).not.toContain('"notify_task_id"');
    expect(dispatcher.prompt).toContain("Create all children before waiting");
  });

  it("keeps the architect a generic software architect rather than a Kanna-specific one", () => {
    const file = readRepoFile(".kanna/agents/architect/AGENT.md");
    const architect = parseAgentDefinition(file);
    const phrases = readRepoPhrases(".kanna/agents/architect/AGENT.md");

    // Any repository orchestrated by Kanna can invoke this agent, so the
    // project under consultation is arbitrary: only the platform is Kanna.
    expect(file).not.toContain("Kanna Architect");
    expect(architect.prompt).toContain("You are a software architect");
    expect(phrases).toContain(
      "The project you are advising on is whatever software this repository holds"
    );
    // The coverage-gap record is conditioned on the repository declaring that
    // convention, never asserted as universal law (nor tied to `AGENTS.md`).
    expect(phrases).toContain("the repository's conventions document requires");
    expect(file).not.toContain("AGENTS.md");

    // Platform mechanics stay: they describe how any agent runs here.
    expect(architect.name).toBe("architect");
    expect(file).toContain("visibility: internal");
    expect(architect.prompt).toContain("kanna_get_task");
    expect(architect.prompt).toContain(
      'kanna_complete_stage {"task_id": "$KANNA_TASK_ID"'
    );
    expect(architect.prompt).toContain("kanna-cli stage-complete");
    expect(architect.prompt).toContain("The task manager remains accountable");
    expect(architect.prompt).toContain(
      "must begin with exactly one of `APPROVE`, `REVISE`, or `STOP-and-escalate`"
    );
  });

  it("keeps the workflow provider schema aligned with the generated registry", () => {
    const schema = JSON.parse(readRepoFile(".kanna/workflows/schema.json")) as {
      $defs?: { agentProvider?: { enum?: string[] } };
    };

    expect(schema.$defs?.agentProvider?.enum).toEqual([...AGENT_PROVIDERS]);
  });

  it("keeps the repo agent provider schema aligned with the generated registry", () => {
    const schema = JSON.parse(readRepoFile(".kanna/config.schema.json")) as {
      $defs?: { agentProvider?: { enum?: string[] } };
      properties?: { agentProviders?: unknown };
    };

    expect(schema.$defs?.agentProvider?.enum).toEqual([...AGENT_PROVIDERS]);
    expect(schema.properties?.agentProviders).toBeDefined();
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
    const qaWorkflow = readRepoFile(".kanna/workflows/single-reviewer.json");

    expect(reviewAgent).toContain("You do not need to inspect the source task worktree");
    expect(reviewAgent).toContain("Do not make code, test, documentation, or configuration changes in the review worktree.");
    expect(reviewAgent).toContain("If the branch requires changes, request a revision back to the `in progress` stage.");
    expect(reviewAgent).toContain('--target-stage "in progress"');
    expect(reviewAgent).not.toContain("Make any fixes only in your current worktree");
    expect(qaWorkflow).toContain("$BASE_REF");
    expect(qaWorkflow).not.toContain("$SOURCE_WORKTREE");
  });

  it("ships the approve step as the pr stage's post instead of a legacy post_action", () => {
    const qaWorkflow = readRepoFile(".kanna/workflows/single-reviewer.json");
    // Legacy `post_action` still compiles at load time for pinned
    // pipeline_def snapshots, but shipped assets must use the current format.
    expect(qaWorkflow).not.toContain("post_action");
    expect(readRepoFile(".kanna/workflows/schema.json")).not.toContain("post_action");

    const parsed = parseWorkflowJson(qaWorkflow);
    const prStage = parsed.stages.find((stage) => stage.name === "pr");
    expect(prStage?.post?.name).toBe("approve");
    expect(prStage?.post?.agent).toBe("approve");
    expect(prStage?.post?.prompt).toContain("$PREV_RESULT");
  });

  it("ships the approve post on the no-review workflow pr stage so advancing queues the merge", () => {
    const parsed = parseWorkflowJson(readRepoFile(".kanna/workflows/no-review.json"));
    const prStage = parsed.stages.find((stage) => stage.name === "pr");
    expect(prStage?.post?.name).toBe("approve");
    expect(prStage?.post?.agent).toBe("approve");
    expect(prStage?.post?.prompt).toContain("$PREV_RESULT");
  });

  it("automates no-review implement revisions without automating the initial handoff", () => {
    const parsed = parseWorkflowJson(readRepoFile(".kanna/workflows/no-review.json"));
    const implement = parsed.stages.find((stage) => stage.name === "in progress");

    expect(implement?.policy).toEqual({
      transition: "manual",
      revision_transition: "auto",
    });
  });

  it("publishes revision transition values in the workflow schema", () => {
    const schema = JSON.parse(readRepoFile(".kanna/workflows/schema.json"));
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
      expect(agent, name).toContain("ask the human to use the desktop revision action");
      expect(agent, name).toContain('origin: "human"');
      expect(agent, name).toContain("stop until the human acts");

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
    const workflow = readRepoFile(".kanna/workflows/specialized-reviewers.json");

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
    expect(dispatcher).toContain("$PREV_MAIN_RESULT");
    // Children judge the round but read the whole branch for context.
    expect(dispatcher).toContain("Changes to review:");
    expect(dispatcher).toContain("Full branch context:");

    // The workflow has to feed the dispatcher the previous stage result for
    // the declined-findings check to be possible at all.
    expect(workflow).toContain("Previous implementation result: $PREV_MAIN_RESULT");
    // `$PREV_RESULT` remains the separate post-result binding used by approve.
    expect(workflow).toContain("Previous result: $PREV_RESULT");
  });

  it("carries the latest durable verdict for each untouched specialty across review rounds", () => {
    const dispatcher = readRepoPhrases(".kanna/agents/qa-dispatcher/AGENT.md");
    const listChildrenMcp = 'kanna_list_task_children {"task_id": "$KANNA_TASK_ID"}';
    const listChildrenCli = 'kanna-cli task children --task-id "$KANNA_TASK_ID"';

    // The task's direct children are the durable verdict history. Query it
    // MCP-first; the typed CLI surface is only the no-MCP fallback.
    expect(dispatcher).toContain(listChildrenMcp);
    expect(dispatcher).toContain(listChildrenCli);
    expect(dispatcher.indexOf(listChildrenMcp)).toBeLessThan(
      dispatcher.indexOf(listChildrenCli)
    );
    expect(dispatcher).toContain("Only when the MCP tool is unavailable");
    expect(dispatcher).toContain("including closed children, oldest first");

    // Workflow identity separates the panel from unrelated direct children;
    // then reduction is by specialty agent and terminal run status.
    expect(dispatcher).toContain('`workflowName == "specialty-review"`');
    expect(dispatcher).toContain(
      "Only those children participate in the specialty ledger"
    );
    expect(dispatcher).toContain(
      "Ignore every child from another workflow, even if it has no run or its `agent` starts with `review-`"
    );
    expect(dispatcher).toContain("latest terminal verdict per specialty");
    expect(dispatcher).toContain(
      "any syntactically valid stored `review-*` agent is a historical specialty key, even if that reviewer is no longer discoverable"
    );
    expect(dispatcher).toContain(
      "Current discovery controls only which agents may be newly dispatched"
    );
    expect(dispatcher).toContain("`succeeded` = PASS and `failed` = FAIL");
    expect(dispatcher).toContain(
      "a missing `agent` or an agent that does not match `review-*` is malformed attribution"
    );
    expect(dispatcher).toContain(
      "Any child record without `workflowName` is version-incomplete history and prevents aggregate success"
    );
    expect(dispatcher).toContain(
      "retry the supported children query at most once if it can return the current shape"
    );
    expect(dispatcher).toContain(
      "broken dispatch with the child id and an explicit incompatible-server or upgrade-required reason"
    );
    expect(dispatcher).toContain("Do not start a repeated retry loop");
    expect(dispatcher).toContain("unresolved dispatch evidence, never PASS");

    // Unresolved records have finite outcomes. Known historical specialties
    // may be joined or re-dispatched once; unattributed closed records cannot
    // be guessed and must end in a single broken-dispatch result.
    expect(dispatcher).toContain(
      "join it if it is running or re-dispatch that specialty at most once when appropriate"
    );
    expect(dispatcher).toContain(
      "A later terminal child for that same historical specialty supersedes the unresolved evidence"
    );
    expect(dispatcher).toContain(
      "A closed `specialty-review` child with malformed attribution cannot be safely re-dispatched"
    );
    expect(dispatcher).toContain(
      "Use broken dispatch once, cite its child id, and do not retry or re-dispatch it"
    );

    // A skipped specialty keeps its actual recorded outcome. Only a later
    // terminal record for that same agent can replace it, so an old failure
    // cannot evaporate merely because this round did not touch its surface.
    expect(dispatcher).toContain(
      "A carried FAIL stays unresolved until a later child for the same specialty records PASS"
    );
    expect(dispatcher).toContain(
      "Never treat an untouched surface as evidence that its carried FAIL was fixed"
    );
    expect(dispatcher).toContain("never reviewed and untouched this round, record no verdict");
    expect(dispatcher).toContain("New child verdicts join the chronological history");

    // Carried failures still pass through the same scope bar. Historical
    // provenance uses only fields the endpoint exposes; it never invents the
    // exact round in which an earlier child ran.
    expect(dispatcher).toContain("A carried FAIL is not automatically in scope");
    expect(dispatcher).toContain(
      "new or carried, with the child id and available `createdAt`/`latestRun.finishedAt` timestamp"
    );
    expect(dispatcher).toContain("surviving unresolved carried FAIL");
    expect(dispatcher).not.toContain("child id and round");
    expect(dispatcher).not.toContain("child/round provenance");
    expect(dispatcher).not.toContain("child <id>, round <m>");
    expect(dispatcher).not.toContain("child <id>, round <k>");
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

  it("uses the task prompt and durable directives without a task-spec artifact", () => {
    const implement = readRepoPhrases(".kanna/agents/implement/AGENT.md");
    const commit = readRepoPhrases(".kanna/agents/commit/AGENT.md");

    expect(implement).not.toContain("task-specs/");
    expect(commit).not.toContain("task-specs/");
    expect(commit).toContain("Inspect the worktree with `git status`");

    for (const name of ["review", "qa-dispatcher"]) {
      const agent = readRepoPhrases(`.kanna/agents/${name}/AGENT.md`);

      expect(agent, name).toContain("original task prompt");
      expect(agent, name).toContain("kanna_task_inputs");
      expect(agent, name).toContain("durable");
      expect(agent, name).not.toContain("docs/task-specs/");
      expect(agent, name).not.toContain("missing spec");
      expect(agent, name).not.toContain("stale spec");
    }

    const dispatcher = readRepoPhrases(".kanna/agents/qa-dispatcher/AGENT.md");
    expect(dispatcher).toContain("Reviewed task id");
    expect(dispatcher).toContain("do not use your child task id for that lookup");
    expect(dispatcher).toContain("delivered owner, manager, and reviewer directives");
    expect(dispatcher).not.toContain("Task spec:");
  });

  it("keeps the dispatched PR reviewers off a required task-spec artifact", () => {
    const reviewer = readRepoPhrases(".kanna/agents/pr-reviewer/AGENT.md");
    const triage = readRepoPhrases(".kanna/agents/pr-triage/AGENT.md");
    const scopeAnswer = readRepoPhrases(".kanna/agents/pr-triage/EXTEND.md");

    // These two read a *reviewed* task's terms the same way the deciding
    // reviewers above do: the original prompt plus the durable delivered
    // directives, looked up by the id in the PR's `Kanna-Task:` trailer. The
    // task usually lives on another machine, so the lookup needs `machine_id`.
    for (const [name, body] of [
      ["pr-reviewer", reviewer],
      ["pr-triage/EXTEND.md", scopeAnswer],
    ] as const) {
      expect(body, name).toContain("kanna_get_task");
      expect(body, name).toContain("kanna_task_inputs");
      expect(body, name).toContain("machine_id");
    }

    // A committed `docs/task-specs/<id>.md` was retired by owner direction.
    // Current tasks legitimately carry a trailer and no such file, so a
    // reviewer that required one would flag every present-day Kanna PR.
    for (const [name, body] of [
      ["pr-reviewer", reviewer],
      ["pr-triage", triage],
      ["pr-triage/EXTEND.md", scopeAnswer],
    ] as const) {
      expect(body, name).not.toContain("missing spec");
      expect(body, name).not.toContain("stale spec");
      expect(body, name).not.toContain("read `docs/task-specs/");
      expect(body, name).not.toContain("has a task spec at");
    }

    // pr-reviewer may still mention the file, but only to disclaim it.
    expect(reviewer).toContain("Never require one");
    expect(reviewer).toContain("never make its absence a finding");
    expect(triage).not.toContain("docs/task-specs/");
    expect(scopeAnswer).not.toContain("docs/task-specs/");
  });

  it("keeps both deciding reviewers inside the original task scope", () => {
    for (const name of ["review", "qa-dispatcher"]) {
      const agent = readRepoPhrases(`.kanna/agents/${name}/AGENT.md`);

      expect(agent, name).toContain("Not for work the original task does not ask for");
      expect(agent, name).not.toContain("Not for work the spec does not ask for");
    }
  });

  it("bounds revision rounds on the dispatched QA workflow and publishes the field", () => {
    const parsed = parseWorkflowJson(readRepoFile(".kanna/workflows/specialized-reviewers.json"));
    expect(parsed.revision_limit).toBe(5);

    const schema = JSON.parse(readRepoFile(".kanna/workflows/schema.json"));
    expect(schema.properties.revision_limit).toMatchObject({ type: "integer", minimum: 0 });
  });

  it("teaches the current revision limit in the workflow factory", () => {
    const workflowFactory = readRepoPhrases(".kanna/agents/workflow-factory/AGENT.md");

    expect(workflowFactory).toContain('"revision_limit": 5');
    expect(workflowFactory).toContain("Defaults to 5; `0` disables the cap");
    expect(workflowFactory).not.toContain('"revision_limit": 3');
    expect(workflowFactory).not.toContain("Defaults to 3; `0` disables the cap");
  });

  it("resolves PR head/base refs with gh pr view even when task metadata has the URL", () => {
    const approveAgent = readRepoPhrases(".kanna/agents/approve/AGENT.md");
    const approveContract = readRepoPhrases(".kanna/agents/approve/CONTRACT.md");

    // The server-owned handoff envelope is built from headRefName/baseRefName,
    // which task metadata never carries — it only has prUrl. Taking the
    // metadata path and skipping `gh pr view` leaves both refs unresolved.
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
    expect(mergeAgent).toContain("retarget direct children onto the next live parent or target");
    // Merge approval is delegated to this checked-in policy, not to a
    // privileged server-built envelope: approve sends an ordinary request and
    // the merge master decides. The compact request line is the shape both
    // sides agree on, so pin it here rather than a `KANNA_MERGE_HANDOFF` blob.
    expect(approveAgent).toContain("kanna_signal_merge_handoff");
    expect(approveAgent).toContain("ordinary request to the repo's merge policy agent");
    expect(approveAgent).not.toContain("KANNA_MERGE_HANDOFF");
    expect(mergeAgent).toContain("MERGE <head> -> <base> [TASK <task-id>] [PR <url>]: <summary>");
    expect(mergeAgent).not.toContain("KANNA_MERGE_HANDOFF");
    expect(mergeAgent).toContain("Leave every merged branch in place");
    expect(mergeAgent).toContain("Never delete a local or remote branch as merge cleanup");
    expect(mergeAgent).not.toContain("kanna_is_dependent_tasks_exist");
    expect(mergeAgent).toContain("gh pr merge <PR> --merge");
    expect(mergeAgent).toContain("Do not push directly to the target branch.");
    expect(mergeAgent).toContain("never pass a branch-deletion flag such as `--delete-branch`");

    const mergeContract = readRepoFile(".kanna/agents/merge/CONTRACT.md");
    const gitFlavor = readRepoFile(".kanna/agents/merge/flavors/git/AGENT.md");
    const githubFlavor = readRepoFile(".kanna/agents/merge/flavors/github/AGENT.md");
    for (const definition of [mergeContract, gitFlavor, githubFlavor]) {
      expect(definition).toMatch(/leave every merged|leave merged local and remote branches/i);
      expect(definition).not.toContain("kanna_is_dependent_tasks_exist");
    }
    expect(githubFlavor).toContain("never pass `--delete-branch`");
  });

  // Every flavor that opens a PR carries its own copy of the steps, so the
  // guards below have to hold for all of them: fixing one path while a
  // sibling keeps opening dead-end and duplicate PRs fixes nothing.
  const PR_CREATING_AGENTS = [
    ".kanna/agents/pr/AGENT.md",
    ".kanna/agents/pr/flavors/draft-pr/AGENT.md",
  ];

  it("makes every PR-creating agent prove its base ref still leads to the default branch", () => {
    // A PR that merges cleanly into an abandoned integration branch is
    // indistinguishable from a healthy one: review, checks, and the mergeable
    // state all pass while the work lands nowhere. $BASE_REF is where the task
    // started, not evidence that the branch is still going anywhere.
    for (const path of PR_CREATING_AGENTS) {
      const agent = readRepoPhrases(path);

      expect(agent, path).toContain("gh pr list --state open --head <base> --json number,url,baseRefName");
      expect(agent, path).toContain("git ls-remote --heads origin <base>");
      expect(agent, path).toContain("git merge-base --is-ancestor origin/<base> origin/<default>");
      // Retargeting must replay only the task's own commits — rebasing onto
      // the default branch without `--onto` drags the dead base's commits in.
      expect(agent, path).toContain("git rebase --onto origin/<default> origin/<base> HEAD");
      // Asking is a valid outcome; silently landing on a dead branch is not.
      expect(agent, path).toContain("Stopping to ask is a correct outcome");
      // Stacked PRs onto a live feature branch stay working.
      expect(agent, path).toContain("Never retarget unconditionally");
      // Distance behind the default branch is corroboration, never the
      // trigger: long-lived stack parents drift behind without being
      // abandoned.
      expect(agent, path).toContain("Do not trigger on how far the base is behind the default branch");
    }

    expect(readRepoPhrases(".kanna/agents/pr/CONTRACT.md")).toContain(
      "still a live path to the default branch",
    );
  });

  it("makes every PR-creating agent find an existing PR the rename step hid", () => {
    // The rename step moves the branch, so a prior PR for this task can sit on
    // a branch name this worktree no longer has — a `gh pr create` that only
    // looked at the current branch opened a duplicate for the same commit.
    for (const path of PR_CREATING_AGENTS) {
      const agent = readRepoPhrases(path);

      expect(agent, path).toContain("Check whether an open PR already covers this work");
      // Matching is on the work: head sha recorded before the rebase, this
      // task's branch names, the task-id trailer, and patch equivalence.
      expect(agent, path).toContain("headRefOid");
      expect(agent, path).toContain('gh pr list --state open --search "$KANNA_TASK_ID in:body"');
      expect(agent, path).toContain("git cherry origin/<headRefName> HEAD");
      expect(agent, path).toContain("Kanna-Task: $KANNA_TASK_ID");
      // Updating means pushing to the PR's branch, not renaming away from it.
      expect(agent, path).toContain("git push --force-with-lease origin HEAD:refs/heads/<headRefName>");
      expect(agent, path).toContain("Do not rename the branch");
    }

    expect(readRepoPhrases(".kanna/agents/pr/CONTRACT.md")).toContain(
      "must not open a second pull request",
    );
  });

  it("keeps pr@draft-pr drafting while it validates the base and reuses PRs", () => {
    // The flavor's whole reason to exist is the draft, so the shared guards
    // must not cost it: it still opens drafts, and reusing a PR that someone
    // already readied must not push it back into draft state.
    const draftFlavor = readRepoPhrases(".kanna/agents/pr/flavors/draft-pr/AGENT.md");

    expect(draftFlavor).toContain("gh pr create --draft --base <target>");
    expect(draftFlavor).toContain("Ready PRs count as matches too, not just drafts");
    expect(draftFlavor).toContain("never convert a ready PR back to a draft");
    expect(readRepoPhrases(".kanna/agents/pr/CONTRACT.md")).toContain(
      "it must leave that PR's draft state alone",
    );
  });

  it("stops the merge master from shipping into an orphaned base", () => {
    // Approve no longer gates on the base: it sends an ordinary request and
    // the merge master owns the decision, so the orphaned-target guard lives
    // on the merge side only. It is one `gh pr list` call, and after the merge
    // the mistake is invisible — so it is worth paying for on every flavor.
    const mergeAgent = readRepoPhrases(".kanna/agents/merge/AGENT.md");
    const mergeGithub = readRepoPhrases(".kanna/agents/merge/flavors/github/AGENT.md");
    const mergeContract = readRepoPhrases(".kanna/agents/merge/CONTRACT.md");

    expect(mergeAgent).toContain("A requested target is not automatically a live one");
    expect(mergeAgent).toContain("ask the operator whether to retarget before merging");
    expect(mergeGithub).toContain("Confirm the resolved target is live before merging");
    expect(mergeContract).toContain("report the orphaned target to the operator instead of merging");
  });
});
