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

  it("setup GitHub preset publishes a PR before native review approval", () => {
    const setupAgent = read(join(agentsRoot, "setup", "AGENT.md"));
    const setupContract = read(join(agentsRoot, "setup", "CONTRACT.md"));
    const setupConfig = parseJsonFenceAfter(
      setupAgent,
      "`.kanna/config.json` selects the pipeline and stock flavors",
    ) as { flavors?: { pr?: unknown; merge?: unknown } };
    const setupPipeline = parseJsonFenceAfter(
      setupAgent,
      "`.kanna/pipelines/github-flow.json` composes the built-in roles",
    ) as {
      stages?: Array<{
        name?: unknown;
        agent?: unknown;
        post?: { name?: unknown; agent?: unknown; prompt?: unknown };
      }>;
    };

    expect(setupConfig.flavors).toMatchObject({
      pr: "draft-pr",
      merge: "github",
    });
    expect(setupPipeline.stages?.map((stage) => stage.name)).toEqual([
      "in progress",
      "pr",
    ]);

    const prStage = setupPipeline.stages?.find((stage) => stage.name === "pr");
    expect(prStage?.agent).toBe("pr");
    expect(prStage?.post).toMatchObject({
      name: "approve",
      agent: "approve",
    });
    expect(prStage?.post?.prompt).toContain("$PREV_RESULT");
    expect(setupAgent).toContain(
      "This composes `pr@draft-pr -> review in Cmd+D -> approve post -> merge@github`",
    );
    expect(setupContract).toContain(
      "must not insert an automatic `review` stage before the `pr` stage",
    );
  });

  it("hands the draft-PR composition from approve to merge@github over one MERGE line", () => {
    // The GitHub preset composes pr@draft-pr -> approve post -> merge@github
    // across three separate agent sessions. Nothing type-checks the handoff:
    // approve emits a MERGE line as free text and merge@github parses it, so
    // the two spellings must stay identical or the approved flow silently
    // strands at the merge master. Live coverage is blocked on the harness in
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

    // The draft PR the preset creates reaches merge@github as a draft:
    // stock approve does not ready it, so merge@github must be the agent
    // that decides, and it skips drafts unless the operator includes them.
    expect(mergeGithub).not.toContain("gh pr ready");
    expect(read(join(agentsRoot, "merge", "AGENT.md"))).toContain(
      "skipping drafts unless the operator includes them",
    );
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
