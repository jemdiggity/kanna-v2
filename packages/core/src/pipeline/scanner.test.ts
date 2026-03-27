import { describe, it, expect } from "vitest";
import { scanAgentsAndPipelines } from "./scanner";

const VALID_AGENT_MD = `---
name: Test Agent
description: A test agent
---

Do the test task.
`;

const INVALID_AGENT_MD = `---
name:
description:
---

`;

const VALID_PIPELINE_JSON = JSON.stringify({
  name: "Test Pipeline",
  stages: [{ name: "Stage 1", transition: "manual" }],
});

const INVALID_PIPELINE_JSON = `{ not valid json`;

describe("scanAgentsAndPipelines", () => {
  it("scans and returns all valid agents", async () => {
    const files: Record<string, string> = {
      "/repo/.kanna/agents/my-agent/AGENT.md": VALID_AGENT_MD,
      "/repo/.kanna/agents/other-agent/AGENT.md": `---
name: Other Agent
description: Another agent
---

Do the other task.
`,
    };

    const readFile = async (path: string): Promise<string> => {
      if (path in files) return files[path];
      throw new Error(`File not found: ${path}`);
    };

    const listDir = async (path: string): Promise<string[]> => {
      if (path === "/repo/.kanna/agents") return ["my-agent", "other-agent"];
      if (path === "/repo/.kanna/pipelines") return [];
      throw new Error(`Directory not found: ${path}`);
    };

    const result = await scanAgentsAndPipelines("/repo", readFile, listDir);

    expect(result.agents).toHaveLength(2);
    expect(result.agents.map((a) => a.name)).toContain("Test Agent");
    expect(result.agents.map((a) => a.name)).toContain("Other Agent");
    expect(result.errors).toHaveLength(0);
  });

  it("scans and returns all valid pipelines", async () => {
    const pipeline2 = JSON.stringify({
      name: "Second Pipeline",
      stages: [{ name: "Deploy", transition: "auto" }],
    });

    const files: Record<string, string> = {
      "/repo/.kanna/pipelines/pipeline1.json": VALID_PIPELINE_JSON,
      "/repo/.kanna/pipelines/pipeline2.json": pipeline2,
    };

    const readFile = async (path: string): Promise<string> => {
      if (path in files) return files[path];
      throw new Error(`File not found: ${path}`);
    };

    const listDir = async (path: string): Promise<string[]> => {
      if (path === "/repo/.kanna/agents") return [];
      if (path === "/repo/.kanna/pipelines") return ["pipeline1.json", "pipeline2.json"];
      throw new Error(`Directory not found: ${path}`);
    };

    const result = await scanAgentsAndPipelines("/repo", readFile, listDir);

    expect(result.pipelines).toHaveLength(2);
    expect(result.pipelines.map((p) => p.name)).toContain("Test Pipeline");
    expect(result.pipelines.map((p) => p.name)).toContain("Second Pipeline");
    expect(result.errors).toHaveLength(0);
  });

  it("skips agents with invalid AGENT.md and reports errors", async () => {
    const files: Record<string, string> = {
      "/repo/.kanna/agents/valid-agent/AGENT.md": VALID_AGENT_MD,
      "/repo/.kanna/agents/invalid-agent/AGENT.md": INVALID_AGENT_MD,
    };

    const readFile = async (path: string): Promise<string> => {
      if (path in files) return files[path];
      throw new Error(`File not found: ${path}`);
    };

    const listDir = async (path: string): Promise<string[]> => {
      if (path === "/repo/.kanna/agents") return ["valid-agent", "invalid-agent"];
      if (path === "/repo/.kanna/pipelines") return [];
      throw new Error(`Directory not found: ${path}`);
    };

    const result = await scanAgentsAndPipelines("/repo", readFile, listDir);

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].name).toBe("Test Agent");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("invalid-agent");
  });

  it("skips pipelines with invalid JSON and reports errors", async () => {
    const files: Record<string, string> = {
      "/repo/.kanna/pipelines/valid.json": VALID_PIPELINE_JSON,
      "/repo/.kanna/pipelines/invalid.json": INVALID_PIPELINE_JSON,
    };

    const readFile = async (path: string): Promise<string> => {
      if (path in files) return files[path];
      throw new Error(`File not found: ${path}`);
    };

    const listDir = async (path: string): Promise<string[]> => {
      if (path === "/repo/.kanna/agents") return [];
      if (path === "/repo/.kanna/pipelines") return ["valid.json", "invalid.json"];
      throw new Error(`Directory not found: ${path}`);
    };

    const result = await scanAgentsAndPipelines("/repo", readFile, listDir);

    expect(result.pipelines).toHaveLength(1);
    expect(result.pipelines[0].name).toBe("Test Pipeline");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("invalid.json");
  });

  it("returns empty arrays when directories don't exist", async () => {
    const readFile = async (path: string): Promise<string> => {
      throw new Error(`File not found: ${path}`);
    };

    const listDir = async (path: string): Promise<string[]> => {
      throw new Error(`Directory not found: ${path}`);
    };

    const result = await scanAgentsAndPipelines("/repo", readFile, listDir);

    expect(result.agents).toHaveLength(0);
    expect(result.pipelines).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("handles mixed valid and invalid files", async () => {
    const files: Record<string, string> = {
      "/repo/.kanna/agents/good-agent/AGENT.md": VALID_AGENT_MD,
      "/repo/.kanna/agents/bad-agent/AGENT.md": INVALID_AGENT_MD,
      "/repo/.kanna/pipelines/good.json": VALID_PIPELINE_JSON,
      "/repo/.kanna/pipelines/bad.json": INVALID_PIPELINE_JSON,
    };

    const readFile = async (path: string): Promise<string> => {
      if (path in files) return files[path];
      throw new Error(`File not found: ${path}`);
    };

    const listDir = async (path: string): Promise<string[]> => {
      if (path === "/repo/.kanna/agents") return ["good-agent", "bad-agent"];
      if (path === "/repo/.kanna/pipelines") return ["good.json", "bad.json"];
      throw new Error(`Directory not found: ${path}`);
    };

    const result = await scanAgentsAndPipelines("/repo", readFile, listDir);

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].name).toBe("Test Agent");
    expect(result.pipelines).toHaveLength(1);
    expect(result.pipelines[0].name).toBe("Test Pipeline");
    expect(result.errors).toHaveLength(2);
  });

  it("ignores non-.json files in pipelines directory", async () => {
    const files: Record<string, string> = {
      "/repo/.kanna/pipelines/pipeline.json": VALID_PIPELINE_JSON,
    };

    const readFile = async (path: string): Promise<string> => {
      if (path in files) return files[path];
      throw new Error(`File not found: ${path}`);
    };

    const listDir = async (path: string): Promise<string[]> => {
      if (path === "/repo/.kanna/agents") return [];
      if (path === "/repo/.kanna/pipelines") return ["pipeline.json", "README.md", ".gitkeep"];
      throw new Error(`Directory not found: ${path}`);
    };

    const result = await scanAgentsAndPipelines("/repo", readFile, listDir);

    expect(result.pipelines).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
  });
});
