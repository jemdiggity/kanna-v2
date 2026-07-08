import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseAgentDefinition } from "../../../packages/core/src/pipeline/agent-loader";

const repoRoot = resolve(new URL("../../..", import.meta.url).pathname);
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
