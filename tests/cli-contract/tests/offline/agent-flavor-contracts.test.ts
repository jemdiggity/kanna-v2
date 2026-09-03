import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseAgentDefinition } from "../../../../packages/core/src/workflow/agent-loader";

// This test lives one lane deeper than the historical flat tests directory.
const repoRoot = resolve(new URL("../../../..", import.meta.url).pathname);
const agentsRoot = join(repoRoot, ".kanna", "agents");
const catalogPath = join(repoRoot, "crates", "kanna-tool-catalog", "src", "catalog.json");

const requiredFlavors = [
  { role: "pr", flavor: "draft-pr" },
  { role: "pr", flavor: "push-only" },
  { role: "merge", flavor: "github" },
  { role: "merge", flavor: "git" },
];

const requiredBuiltInAgents = ["setup"];

// The user-facing workflow lineup, in increasing review depth. `no-review` is
// the fallback the server resolves when a repo names no workflow, so its name
// is load-bearing. `specialty-review` is excluded: it is the single-stage
// workflow qa-dispatcher gives its child tasks, and its definition declares
// `"visibility": "internal"` so the server never offers it as a choice.
const BUILTIN_WORKFLOWS = ["no-review", "single-reviewer", "specialized-reviewers"];

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function parseJsonFenceAfter(content: string, marker: string): unknown {
  const markerIndex = content.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`Could not find marker: ${marker}`);
  }

  const fenceMatch = /```json\n([\s\S]*?)\n```/.exec(content.slice(markerIndex));
  if (!fenceMatch) {
    throw new Error(`Could not find JSON fence after marker: ${marker}`);
  }

  return JSON.parse(fenceMatch[1]);
}

function catalogToolNames(): Set<string> {
  const parsed = JSON.parse(read(catalogPath)) as { tools?: Array<{ name?: unknown }> };
  return new Set(
    (parsed.tools ?? [])
      .map((tool) => tool.name)
      .filter((name): name is string => typeof name === "string"),
  );
}

function toolReferences(content: string): string[] {
  return [...content.matchAll(/\bkanna_[a-z_]+\b/g)].map((match) => match[0]);
}

function renderPrompt(prompt: string): string {
  const vars: Record<string, string> = {
    BASE_REF: "origin/main",
    BRANCH: "task-example",
    KANNA_TASK_ID: "task-example",
    MERGE_STRATEGY: "merge",
    REVIEW_TEAM: "platform",
    SOURCE_WORKTREE: "/tmp/repo/.kanna-worktrees/task-example",
    TASK_PROMPT: "Implement the requested task.",
  };
  return prompt.replace(/\$\{([A-Z][A-Z0-9_]*)\}|\$([A-Z][A-Z0-9_]*)/g, (match, braced: string | undefined, bare: string | undefined) => {
    const name = braced ?? bare;
    return vars[name] ?? match;
  });
}

describe("bundled agent flavor contracts", () => {
  const tools = catalogToolNames();

  for (const { role, flavor } of requiredFlavors) {
    const selector = `${role}@${flavor}`;
    const agentPath = join(agentsRoot, role, "flavors", flavor, "AGENT.md");

    it(`${selector} ships as a bundled AGENT.md resource`, () => {
      expect(existsSync(agentPath), `${agentPath} must exist`).toBe(true);
    });

    it(`${selector} parses and renders`, () => {
      const agent = parseAgentDefinition(read(agentPath));
      expect(agent.name).toBe(selector);
      expect(agent.description).not.toBe("");
      expect(renderPrompt(agent.prompt).trim()).not.toBe("");
    });

    it(`${selector} references only catalogued Kanna tools`, () => {
      const missing = toolReferences(read(agentPath)).filter((name) => !tools.has(name));
      expect([...new Set(missing)]).toEqual([]);
    });
  }

  for (const role of ["pr", "merge", "review", "commit", "approve", "ship"]) {
    const contractPath = join(agentsRoot, role, "CONTRACT.md");

    it(`${role} contract doc ships next to the agent definition`, () => {
      expect(existsSync(contractPath), `${contractPath} must exist`).toBe(true);
    });

    it(`${role} contract references only catalogued Kanna tools`, () => {
      const missing = toolReferences(read(contractPath)).filter((name) => !tools.has(name));
      expect([...new Set(missing)]).toEqual([]);
    });
  }

  for (const role of requiredBuiltInAgents) {
    const agentPath = join(agentsRoot, role, "AGENT.md");
    const contractPath = join(agentsRoot, role, "CONTRACT.md");

    it(`${role} ships as a bundled AGENT.md resource`, () => {
      expect(existsSync(agentPath), `${agentPath} must exist`).toBe(true);
    });

    it(`${role} parses and renders`, () => {
      const agent = parseAgentDefinition(read(agentPath));
      expect(agent.name).toBe(role);
      expect(agent.description).not.toBe("");
      expect(renderPrompt(agent.prompt).trim()).not.toBe("");
    });

    it(`${role} contract doc ships next to the agent definition`, () => {
      expect(existsSync(contractPath), `${contractPath} must exist`).toBe(true);
    });

    it(`${role} references only catalogued Kanna tools`, () => {
      const missing = [
        ...toolReferences(read(agentPath)),
        ...toolReferences(read(contractPath)),
      ].filter((name) => !tools.has(name));
      expect([...new Set(missing)]).toEqual([]);
    });
  }

  it("setup GitHub preset selects a built-in workflow instead of authoring one", () => {
    const setupAgent = read(join(agentsRoot, "setup", "AGENT.md"));
    const setupContract = read(join(agentsRoot, "setup", "CONTRACT.md"));
    const setupConfig = parseJsonFenceAfter(
      setupAgent,
      "`.kanna/config.json` selects the workflow and stock flavors",
    ) as { workflow?: unknown; flavors?: { pr?: unknown; merge?: unknown } };

    // A copied workflow file would fossilize whatever the built-ins looked
    // like on the day setup ran. Selecting one keeps the repo on the shipped
    // definition, so the preset is a config selection, not a workflow author.
    expect(setupConfig.workflow).toBe("no-review");
    expect(BUILTIN_WORKFLOWS).toContain(setupConfig.workflow);
    expect(setupAgent).not.toContain("github-flow.json");
    expect(setupContract).toContain("not author a workflow file of its own");
    for (const name of BUILTIN_WORKFLOWS) {
      expect(setupAgent, `offers ${name}`).toContain(`\`${name}\``);
    }

    // No draft flavor by default: merge@github cannot merge a draft, so a
    // stock preset that opened one would strand at the merge master.
    expect(setupConfig.flavors).toMatchObject({ merge: "github" });
    expect(setupConfig.flavors).not.toHaveProperty("pr");
    expect(setupContract).toContain("must not select `pr@draft-pr`");
  });

  it("keeps every setup answer combination internally composable", () => {
    const setupAgent = read(join(agentsRoot, "setup", "AGENT.md"));
    const setupContract = read(join(agentsRoot, "setup", "CONTRACT.md"));
    const approveAgent = read(join(agentsRoot, "approve", "AGENT.md"));

    // The constraint every rule below derives from: approve resolves the PR
    // with `gh pr view` and fails when there is none, and every built-in
    // workflow ends with a pr stage carrying an approve post. So the flavor
    // answers are not independent of the workflow selection.
    expect(approveAgent).toContain("gh pr view");
    expect(approveAgent).toContain("complete this stage as failure");
    for (const name of BUILTIN_WORKFLOWS) {
      const workflow = JSON.parse(
        read(join(repoRoot, ".kanna", "workflows", `${name}.json`)),
      ) as { stages?: Array<{ name?: unknown; post?: { agent?: unknown } }> };
      const prStage = workflow.stages?.find((stage) => stage.name === "pr");
      expect(prStage?.post?.agent, `${name} pr stage post`).toBe("approve");
    }

    // push-only publishes no PR, so pairing it with a built-in would hand
    // approve a PR that does not exist.
    expect(setupAgent).toContain("Never select a built-in workflow with push-only");
    expect(setupContract).toContain("must never be paired with a built-in workflow");

    // Manual merge: nothing consumes the signal, so the post must go too.
    expect(setupContract).toContain(
      "Manual merge likewise requires omitting the `approve` post",
    );

    // Draft + merge agent is only coherent with the readying extension.
    expect(setupAgent).toContain(".kanna/agents/approve/EXTEND.md");
    expect(setupContract).toContain("readies the draft before signaling");

    // The rule set must be closed, so an unlisted combination is a question
    // for the user rather than an invented fourth shape.
    expect(setupAgent).toContain("This list is closed");
  });

  it("declares the choice lineup through definition visibility, not code", () => {
    // The server offers exactly the definitions that do not declare
    // `visibility: internal`, so the lineup constant above is only truthful
    // while the bundled files agree with it.
    const specialty = JSON.parse(
      read(join(repoRoot, ".kanna", "workflows", "specialty-review.json")),
    ) as { visibility?: unknown };
    expect(specialty.visibility).toBe("internal");

    for (const name of BUILTIN_WORKFLOWS) {
      const workflow = JSON.parse(
        read(join(repoRoot, ".kanna", "workflows", `${name}.json`)),
      ) as { visibility?: unknown };
      expect(workflow.visibility, `${name} stays a public choice`).toBeUndefined();
    }

    // Kanna binds the commit and approve stage posts itself; their AGENT.md
    // frontmatter keeps them out of the agent listing the same way.
    for (const role of ["commit", "approve"]) {
      const frontmatter = read(join(agentsRoot, role, "AGENT.md"));
      expect(frontmatter, `${role} is internal`).toContain("visibility: internal");
    }
  });

  it("ships the three built-in workflows the setup interview offers", () => {
    for (const name of BUILTIN_WORKFLOWS) {
      const path = join(repoRoot, ".kanna", "workflows", `${name}.json`);
      expect(existsSync(path), `${path} must exist`).toBe(true);

      const workflow = JSON.parse(read(path)) as {
        name?: unknown;
        stages?: Array<{ name?: unknown; agent?: unknown }>;
      };
      expect(workflow.name, `${name} name matches its filename`).toBe(name);

      // Review depth is the only axis that varies: every one of them
      // implements, commits as a post, and ends at a pr stage.
      const stageNames = workflow.stages?.map((stage) => stage.name);
      expect(stageNames?.[0], name).toBe("in progress");
      expect(stageNames?.at(-1), name).toBe("pr");
    }

    const reviewAgentFor = (name: string) => {
      const workflow = JSON.parse(
        read(join(repoRoot, ".kanna", "workflows", `${name}.json`)),
      ) as { stages?: Array<{ name?: unknown; agent?: unknown }> };
      return workflow.stages?.find((stage) => stage.name === "review")?.agent;
    };

    expect(reviewAgentFor("no-review")).toBeUndefined();
    expect(reviewAgentFor("single-reviewer")).toBe("review");
    expect(reviewAgentFor("specialized-reviewers")).toBe("qa-dispatcher");
  });

  it("hands approval to merge@github as an ordinary policy request", () => {
    // The GitHub preset composes pr -> approve post -> merge@github across
    // three separate agent sessions. The approve role sends the resolved PR
    // details and the merge role independently applies repository policy.
    const REQUEST_PREFIX = "MERGE <head> -> <base>";

    const approveAgent = read(join(agentsRoot, "approve", "AGENT.md"));
    const approveContract = read(join(agentsRoot, "approve", "CONTRACT.md"));
    const mergeGithub = read(join(agentsRoot, "merge", "flavors", "github", "AGENT.md"));

    expect(approveAgent).toContain("kanna_signal_merge_handoff");
    expect(approveContract).toContain("kanna_signal_merge_handoff");
    expect(approveContract).toContain(REQUEST_PREFIX);
    expect(mergeGithub).toContain(REQUEST_PREFIX);
    expect(mergeGithub).not.toContain("KANNA_MERGE_HANDOFF");

    // The stock preset opens an ordinary PR, so nothing needs readying. A
    // repo that opts into pr@draft-pr still reaches this agent, and
    // `gh pr merge` fails on a draft — merge@github must say so rather than
    // running a command GitHub rejects.
    expect(mergeGithub).toContain("GitHub refuses this while a PR is still a draft");
  });

  it("does not silently drop newly added flavor files from contract coverage", () => {
    const shipped = requiredFlavors.map(({ role, flavor }) => `${role}/${flavor}`).sort();
    const discovered = readdirSync(agentsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((roleDir) => {
        const flavorsDir = join(agentsRoot, roleDir.name, "flavors");
        if (!existsSync(flavorsDir)) return [];
        return readdirSync(flavorsDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((flavorDir) => `${roleDir.name}/${flavorDir.name}`);
      })
      .sort();

    expect(discovered).toEqual(shipped);
  });
});
