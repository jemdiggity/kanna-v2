import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyAgentExtension,
  parseAgentDefinition,
  parseAgentExtension,
  validateAgentDefinition,
} from "./agent-loader";

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

  it("parses the built-in comma-separated multi-provider agent_provider", () => {
    const content = `---
name: Impl
description: Multi provider
agent_provider: codex, claude, copilot, opencode, antigravity
---

Do something.
`;
    const result = parseAgentDefinition(content);
    expect(result.agent_provider).toEqual(["codex", "claude", "copilot", "opencode", "antigravity"]);
  });

  it("rejects unknown agent_provider values from frontmatter", () => {
    const content = `---
name: Bad Provider
description: Has a typo'd provider
agent_provider: codx
---

Do something.
`;
    expect(() => parseAgentDefinition(content)).toThrow(/agent_provider.*codx/);
  });

  it("rejects an unknown provider inside a comma-separated list", () => {
    const content = `---
name: Bad Provider
description: One typo among valid providers
agent_provider: codex, claud, copilot
---

Do something.
`;
    expect(() => parseAgentDefinition(content)).toThrow(/agent_provider.*claud/);
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

  it("rejects invalid permission_mode values from frontmatter", () => {
    const content = `---
name: Bad Permission Agent
description: Has an invalid permission mode
permission_mode: neverAsk
---

Do something.
`;

    expect(() => parseAgentDefinition(content)).toThrow(/permission_mode.*neverAsk/);
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

  it("keeps the built-in implement agent inside the Kanna pipeline boundary", () => {
    const content = readFileSync(
      new URL("../../../../.kanna/agents/implement/AGENT.md", import.meta.url),
      "utf8"
    );
    const result = parseAgentDefinition(content);

    expect(result.prompt).toContain("Do not push a branch or create a pull request");
    expect(result.prompt).toContain("kanna_complete_stage");
    expect(result.prompt).toContain("kanna-cli stage-complete");
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

  it("returns error for an unknown agent_provider in the list", () => {
    const def = {
      name: "Valid Name",
      description: "Valid description",
      agent_provider: ["codex", "nope"],
      prompt: "Do something.",
    };
    const errors = validateAgentDefinition(def);
    expect(errors.some((e) => e.includes("agent_provider"))).toBe(true);
  });

  it("accepts all known agent_provider values", () => {
    const def = {
      name: "Valid Name",
      description: "Valid description",
      agent_provider: ["claude", "copilot", "codex", "opencode", "antigravity"],
      prompt: "Do something.",
    };
    expect(validateAgentDefinition(def)).toEqual([]);
  });
});

describe("parseAgentExtension", () => {
  it("parses a plain markdown file as a pure prompt extension", () => {
    const ext = parseAgentExtension("## Extra Rules\n\nAlways run the full test suite.\n");
    expect(ext.prompt).toBe("## Extra Rules\n\nAlways run the full test suite.");
    expect(ext.description).toBeUndefined();
    expect(ext.model).toBeUndefined();
    expect(ext.permission_mode).toBeUndefined();
    expect(ext.allowed_tools).toBeUndefined();
    expect(ext.agent_provider).toBeUndefined();
  });

  it("parses frontmatter overrides", () => {
    const content = `---
description: Stricter review agent
model: opus
permission_mode: acceptEdits
allowed_tools:
  - Bash
agent_provider: claude
---

Extra instructions.
`;
    const ext = parseAgentExtension(content);
    expect(ext.description).toBe("Stricter review agent");
    expect(ext.model).toBe("opus");
    expect(ext.permission_mode).toBe("acceptEdits");
    expect(ext.allowed_tools).toEqual(["Bash"]);
    expect(ext.agent_provider).toEqual(["claude"]);
    expect(ext.prompt).toBe("Extra instructions.");
  });

  it("rejects invalid permission_mode values", () => {
    const content = `---
permission_mode: neverAsk
---

Extra instructions.
`;
    expect(() => parseAgentExtension(content)).toThrow(/permission_mode.*neverAsk/);
  });
});

describe("applyAgentExtension", () => {
  const base = {
    name: "review",
    description: "Reviews branches",
    model: "sonnet",
    permission_mode: "default" as const,
    allowed_tools: ["Read"],
    agent_provider: ["codex", "claude"],
    prompt: "Review the branch.",
  };

  it("appends the extension body to the base prompt", () => {
    const merged = applyAgentExtension(base, parseAgentExtension("Run the full test suite."));
    expect(merged.prompt).toBe("Review the branch.\n\nRun the full test suite.");
  });

  it("keeps base fields when the extension does not override them", () => {
    const merged = applyAgentExtension(base, parseAgentExtension("Extra."));
    expect(merged.name).toBe("review");
    expect(merged.description).toBe("Reviews branches");
    expect(merged.model).toBe("sonnet");
    expect(merged.permission_mode).toBe("default");
    expect(merged.allowed_tools).toEqual(["Read"]);
    expect(merged.agent_provider).toEqual(["codex", "claude"]);
  });

  it("overrides base fields present in the extension frontmatter", () => {
    const content = `---
description: Stricter review
model: opus
permission_mode: dontAsk
allowed_tools:
  - Bash
agent_provider: claude
---

Extra.
`;
    const merged = applyAgentExtension(base, parseAgentExtension(content));
    expect(merged.description).toBe("Stricter review");
    expect(merged.model).toBe("opus");
    expect(merged.permission_mode).toBe("dontAsk");
    expect(merged.allowed_tools).toEqual(["Bash"]);
    expect(merged.agent_provider).toEqual(["claude"]);
    expect(merged.prompt).toBe("Review the branch.\n\nExtra.");
  });

  it("keeps the base prompt when the extension body is empty", () => {
    const merged = applyAgentExtension(base, parseAgentExtension("---\nmodel: opus\n---\n"));
    expect(merged.prompt).toBe("Review the branch.");
    expect(merged.model).toBe("opus");
  });

  it("uses the extension body alone when the base prompt is empty", () => {
    const merged = applyAgentExtension({ ...base, prompt: "" }, parseAgentExtension("Only extension."));
    expect(merged.prompt).toBe("Only extension.");
  });

  it("cannot rename the agent", () => {
    const merged = applyAgentExtension(base, parseAgentExtension("---\nname: hijack\n---\n\nExtra."));
    expect(merged.name).toBe("review");
  });

  it("rejects a merged definition with an unknown agent_provider", () => {
    const content = `---
agent_provider: claude, nope
---

Extra.
`;
    expect(() => applyAgentExtension(base, parseAgentExtension(content))).toThrow(/agent_provider.*nope/);
  });

  it("extends the built-in review agent with the repo extension", () => {
    const agentContent = readFileSync(
      new URL("../../../../.kanna/agents/review/AGENT.md", import.meta.url),
      "utf8"
    );
    const extendContent = readFileSync(
      new URL("../../../../.kanna/agents/review/EXTEND.md", import.meta.url),
      "utf8"
    );
    const merged = applyAgentExtension(parseAgentDefinition(agentContent), parseAgentExtension(extendContent));

    expect(merged.name).toBe("review");
    expect(merged.prompt).toContain("Do not create a PR yourself.");
    expect(merged.prompt).toContain("Kanna Repository Test Requirements");
    expect(merged.prompt.indexOf("Kanna Repository Test Requirements")).toBeGreaterThan(
      merged.prompt.indexOf("Do not create a PR yourself.")
    );
  });
});
