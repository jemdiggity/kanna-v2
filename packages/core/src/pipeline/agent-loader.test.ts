import { describe, it, expect } from "vitest";
import { parseAgentDefinition, validateAgentDefinition } from "./agent-loader";

describe("parseAgentDefinition", () => {
  it("parses valid AGENT.md with all fields", () => {
    const content = `---
name: My Agent
description: Does something useful
agent_provider: codex
model: gpt-5
permission_mode: dontAsk
allowed_tools:
  - Bash
  - Read
---

You are a helpful agent. Do the task.
`;
    const result = parseAgentDefinition(content);
    expect(result.name).toBe("My Agent");
    expect(result.description).toBe("Does something useful");
    expect(result.agent_provider).toEqual(["codex"]);
    expect(result.model).toBe("gpt-5");
    expect(result.permission_mode).toBe("dontAsk");
    expect(result.allowed_tools).toEqual(["Bash", "Read"]);
    expect(result.prompt).toBe("You are a helpful agent. Do the task.");
  });

  it("parses minimal AGENT.md with only name and description", () => {
    const content = `---
name: Minimal Agent
description: A simple agent
---

Do the minimal thing.
`;
    const result = parseAgentDefinition(content);
    expect(result.name).toBe("Minimal Agent");
    expect(result.description).toBe("A simple agent");
    expect(result.agent_provider).toBeUndefined();
    expect(result.model).toBeUndefined();
    expect(result.permission_mode).toBeUndefined();
    expect(result.prompt).toBe("Do the minimal thing.");
  });

  it("parses agent_provider as a single string into array", () => {
    const content = `---
name: Single Provider
description: Has one provider
agent_provider: codex
---

Do something.
`;
    const result = parseAgentDefinition(content);
    expect(result.agent_provider).toEqual(["codex"]);
  });

  it("parses agent_provider as a comma-separated list into array", () => {
    const content = `---
name: Multi Provider
description: Has multiple providers
agent_provider: "codex, copilot"
---

Do something.
`;
    const result = parseAgentDefinition(content);
    expect(result.agent_provider).toEqual(["codex", "copilot"]);
  });

  it("parses agent_provider as a YAML array into array", () => {
    const content = `---
name: Array Provider
description: Has array providers
agent_provider:
  - codex
  - copilot
---

Do something.
`;
    const result = parseAgentDefinition(content);
    expect(result.agent_provider).toEqual(["codex", "copilot"]);
  });

  it("uses markdown body as the prompt field", () => {
    const content = `---
name: Body Agent
description: Tests body parsing
---

# Agent Instructions

- Step one
- Step two

Finish the task.
`;
    const result = parseAgentDefinition(content);
    expect(result.prompt).toContain("# Agent Instructions");
    expect(result.prompt).toContain("Finish the task.");
  });
});

describe("validateAgentDefinition", () => {
  it("returns empty array for a valid definition", () => {
    const def = {
      name: "Valid Agent",
      description: "Does things",
      prompt: "Do the things.",
    };
    expect(validateAgentDefinition(def)).toEqual([]);
  });

  it("returns error when name is missing", () => {
    const def = {
      name: "",
      description: "Has description",
      prompt: "Do something.",
    };
    const errors = validateAgentDefinition(def);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("name"))).toBe(true);
  });

  it("returns error when description is missing", () => {
    const def = {
      name: "Valid Name",
      description: "",
      prompt: "Do something.",
    };
    const errors = validateAgentDefinition(def);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("description"))).toBe(true);
  });

  it("allows empty prompt (stage prompt provides the task)", () => {
    const def = {
      name: "Valid Name",
      description: "Valid description",
      prompt: "",
    };
    expect(validateAgentDefinition(def)).toEqual([]);
  });

  it("returns error for invalid permission_mode value", () => {
    const def = {
      name: "Valid Name",
      description: "Valid description",
      permission_mode: "badMode" as "default" | "acceptEdits" | "dontAsk",
      prompt: "Do something.",
    };
    const errors = validateAgentDefinition(def);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("permission_mode"))).toBe(true);
  });

  it("accepts valid permission_mode values", () => {
    const modes = ["default", "acceptEdits", "dontAsk"] as const;
    for (const mode of modes) {
      const def = {
        name: "Valid Name",
        description: "Valid description",
        permission_mode: mode,
        prompt: "Do something.",
      };
      expect(validateAgentDefinition(def)).toEqual([]);
    }
  });
});
