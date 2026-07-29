import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseAgentDefinition } from "../../../../packages/core/src/pipeline/agent-loader";

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

// The user-facing pipeline lineup, in increasing review depth. `no-review` is
// the fallback the server resolves when a repo names no pipeline, so its name
// is load-bearing. `specialty-review` is excluded: it is the internal
// single-stage pipeline qa-dispatcher gives its child tasks, not a choice.
const BUILTIN_PIPELINES = ["no-review", "single-reviewer", "specialized-reviewers"];

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

  for (const role of ["pr", "merge", "review", "commit", "approve"]) {
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

  it("setup GitHub preset selects a built-in pipeline instead of authoring one", () => {
    const setupAgent = read(join(agentsRoot, "setup", "AGENT.md"));
    const setupContract = read(join(agentsRoot, "setup", "CONTRACT.md"));
    const setupConfig = parseJsonFenceAfter(
      setupAgent,
      "`.kanna/config.json` selects the pipeline and stock flavors",
    ) as { pipeline?: unknown; flavors?: { pr?: unknown; merge?: unknown } };

    // A copied pipeline file would fossilize whatever the built-ins looked
    // like on the day setup ran. Selecting one keeps the repo on the shipped
    // definition, so the preset is a config selection, not a pipeline author.
    expect(setupConfig.pipeline).toBe("no-review");
    expect(BUILTIN_PIPELINES).toContain(setupConfig.pipeline);
    expect(setupAgent).not.toContain("github-flow.json");
    expect(setupContract).toContain("not author a pipeline file of its own");
    for (const name of BUILTIN_PIPELINES) {
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
    // pipeline ends with a pr stage carrying an approve post. So the flavor
    // answers are not independent of the pipeline selection.
    expect(approveAgent).toContain("gh pr view");
    expect(approveAgent).toContain("complete this stage as failure");
    for (const name of BUILTIN_PIPELINES) {
      const pipeline = JSON.parse(
        read(join(repoRoot, ".kanna", "pipelines", `${name}.json`)),
      ) as { stages?: Array<{ name?: unknown; post?: { agent?: unknown } }> };
      const prStage = pipeline.stages?.find((stage) => stage.name === "pr");
      expect(prStage?.post?.agent, `${name} pr stage post`).toBe("approve");
    }

    // push-only publishes no PR, so pairing it with a built-in would hand
    // approve a PR that does not exist.
    expect(setupAgent).toContain("Never select a built-in pipeline with push-only");
    expect(setupContract).toContain("must never be paired with a built-in pipeline");

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

  it("ships the three built-in pipelines the setup interview offers", () => {
    for (const name of BUILTIN_PIPELINES) {
      const path = join(repoRoot, ".kanna", "pipelines", `${name}.json`);
      expect(existsSync(path), `${path} must exist`).toBe(true);

      const pipeline = JSON.parse(read(path)) as {
        name?: unknown;
        stages?: Array<{ name?: unknown; agent?: unknown }>;
      };
      expect(pipeline.name, `${name} name matches its filename`).toBe(name);

      // Review depth is the only axis that varies: every one of them
      // implements, commits as a post, and ends at a pr stage.
      const stageNames = pipeline.stages?.map((stage) => stage.name);
      expect(stageNames?.[0], name).toBe("in progress");
      expect(stageNames?.at(-1), name).toBe("pr");
    }

    const reviewAgentFor = (name: string) => {
      const pipeline = JSON.parse(
        read(join(repoRoot, ".kanna", "pipelines", `${name}.json`)),
      ) as { stages?: Array<{ name?: unknown; agent?: unknown }> };
      return pipeline.stages?.find((stage) => stage.name === "review")?.agent;
    };

    expect(reviewAgentFor("no-review")).toBeUndefined();
    expect(reviewAgentFor("single-reviewer")).toBe("review");
    expect(reviewAgentFor("specialized-reviewers")).toBe("qa-dispatcher");
  });

  it("hands the draft-PR composition from approve to merge@github over one MERGE line", () => {
    // The GitHub preset composes pr -> approve post -> merge@github across
    // three separate agent sessions. Nothing type-checks the handoff: approve
    // emits a MERGE line as free text and merge@github parses it, so the two
    // spellings must stay identical or the approved flow silently strands at
    // the merge master. Live coverage is blocked on the harness in
    // docs/2026-07-08-setup-agent-live-e2e-gap.md.
    const MERGE_LINE = "MERGE <branch> -> <target> [TASK <task_id>] [PR <url>]: <summary>";

    const approveAgent = read(join(agentsRoot, "approve", "AGENT.md"));
    const approveContract = read(join(agentsRoot, "approve", "CONTRACT.md"));
    const mergeGithub = read(join(agentsRoot, "merge", "flavors", "github", "AGENT.md"));

    for (const [label, content] of [
      ["approve AGENT.md", approveAgent],
      ["approve CONTRACT.md", approveContract],
      ["merge@github AGENT.md", mergeGithub],
    ] as const) {
      expect(content, label).toContain(MERGE_LINE);
    }

    // approve addresses the merge master by role name, and merge@github is
    // the flavor that role resolves to under the preset's config.
    expect(approveAgent).toContain('`agent = "merge"`');
    expect(approveContract).toContain('`agent = "merge"`');

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
