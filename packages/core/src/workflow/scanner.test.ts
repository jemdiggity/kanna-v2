import { describe, it, expect } from "vitest";
import { scanAgentsAndWorkflows } from "./scanner";

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

const VALID_WORKFLOW_JSON = JSON.stringify({
  name: "Test Workflow",
  stages: [{ name: "Stage 1", transition: "manual" }],
});

const INVALID_WORKFLOW_JSON = `{ not valid json`;

describe("scanAgentsAndWorkflows", () => {
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
      if (path === "/repo/.kanna/workflows") return [];
      throw new Error(`Directory not found: ${path}`);
    };

    const result = await scanAgentsAndWorkflows("/repo", readFile, listDir);

    expect(result.agents).toHaveLength(2);
    expect(result.agents.map((a) => a.name)).toContain("Test Agent");
    expect(result.agents.map((a) => a.name)).toContain("Other Agent");
    expect(result.errors).toHaveLength(0);
  });

  it("scans and returns all valid workflows", async () => {
    const workflow2 = JSON.stringify({
      name: "Second Workflow",
      stages: [{ name: "Deploy", transition: "auto" }],
    });

    const files: Record<string, string> = {
      "/repo/.kanna/workflows/workflow1.json": VALID_WORKFLOW_JSON,
      "/repo/.kanna/workflows/workflow2.json": workflow2,
    };

    const readFile = async (path: string): Promise<string> => {
      if (path in files) return files[path];
      throw new Error(`File not found: ${path}`);
    };

    const listDir = async (path: string): Promise<string[]> => {
      if (path === "/repo/.kanna/agents") return [];
      if (path === "/repo/.kanna/workflows") return ["workflow1.json", "workflow2.json"];
      throw new Error(`Directory not found: ${path}`);
    };

    const result = await scanAgentsAndWorkflows("/repo", readFile, listDir);

    expect(result.workflows).toHaveLength(2);
    expect(result.workflows.map((p) => p.name)).toContain("Test Workflow");
    expect(result.workflows.map((p) => p.name)).toContain("Second Workflow");
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
      if (path === "/repo/.kanna/workflows") return [];
      throw new Error(`Directory not found: ${path}`);
    };

    const result = await scanAgentsAndWorkflows("/repo", readFile, listDir);

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].name).toBe("Test Agent");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("invalid-agent");
  });

  it("skips workflows with invalid JSON and reports errors", async () => {
    const files: Record<string, string> = {
      "/repo/.kanna/workflows/valid.json": VALID_WORKFLOW_JSON,
      "/repo/.kanna/workflows/invalid.json": INVALID_WORKFLOW_JSON,
    };

    const readFile = async (path: string): Promise<string> => {
      if (path in files) return files[path];
      throw new Error(`File not found: ${path}`);
    };

    const listDir = async (path: string): Promise<string[]> => {
      if (path === "/repo/.kanna/agents") return [];
      if (path === "/repo/.kanna/workflows") return ["valid.json", "invalid.json"];
      throw new Error(`Directory not found: ${path}`);
    };

    const result = await scanAgentsAndWorkflows("/repo", readFile, listDir);

    expect(result.workflows).toHaveLength(1);
    expect(result.workflows[0].name).toBe("Test Workflow");
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

    const result = await scanAgentsAndWorkflows("/repo", readFile, listDir);

    expect(result.agents).toHaveLength(0);
    expect(result.workflows).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("handles mixed valid and invalid files", async () => {
    const files: Record<string, string> = {
      "/repo/.kanna/agents/good-agent/AGENT.md": VALID_AGENT_MD,
      "/repo/.kanna/agents/bad-agent/AGENT.md": INVALID_AGENT_MD,
      "/repo/.kanna/workflows/good.json": VALID_WORKFLOW_JSON,
      "/repo/.kanna/workflows/bad.json": INVALID_WORKFLOW_JSON,
    };

    const readFile = async (path: string): Promise<string> => {
      if (path in files) return files[path];
      throw new Error(`File not found: ${path}`);
    };

    const listDir = async (path: string): Promise<string[]> => {
      if (path === "/repo/.kanna/agents") return ["good-agent", "bad-agent"];
      if (path === "/repo/.kanna/workflows") return ["good.json", "bad.json"];
      throw new Error(`Directory not found: ${path}`);
    };

    const result = await scanAgentsAndWorkflows("/repo", readFile, listDir);

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].name).toBe("Test Agent");
    expect(result.workflows).toHaveLength(1);
    expect(result.workflows[0].name).toBe("Test Workflow");
    expect(result.errors).toHaveLength(2);
  });

  it("ignores non-.json files in workflows directory", async () => {
    const files: Record<string, string> = {
      "/repo/.kanna/workflows/workflow.json": VALID_WORKFLOW_JSON,
    };

    const readFile = async (path: string): Promise<string> => {
      if (path in files) return files[path];
      throw new Error(`File not found: ${path}`);
    };

    const listDir = async (path: string): Promise<string[]> => {
      if (path === "/repo/.kanna/agents") return [];
      if (path === "/repo/.kanna/workflows") return ["workflow.json", "README.md", ".gitkeep"];
      throw new Error(`Directory not found: ${path}`);
    };

    const result = await scanAgentsAndWorkflows("/repo", readFile, listDir);

    expect(result.workflows).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
  });

  it("ignores schema.json in workflows directory", async () => {
    const files: Record<string, string> = {
      "/repo/.kanna/workflows/workflow.json": VALID_WORKFLOW_JSON,
      "/repo/.kanna/workflows/schema.json": JSON.stringify({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "Kanna Workflow Definition",
        "type": "object",
      }),
    };

    const readFile = async (path: string): Promise<string> => {
      if (path in files) return files[path];
      throw new Error(`File not found: ${path}`);
    };

    const listDir = async (path: string): Promise<string[]> => {
      if (path === "/repo/.kanna/agents") return [];
      if (path === "/repo/.kanna/workflows") return ["workflow.json", "schema.json"];
      throw new Error(`Directory not found: ${path}`);
    };

    const result = await scanAgentsAndWorkflows("/repo", readFile, listDir);

    expect(result.workflows).toHaveLength(1);
    expect(result.workflows[0].name).toBe("Test Workflow");
    expect(result.errors).toHaveLength(0);
  });
});
