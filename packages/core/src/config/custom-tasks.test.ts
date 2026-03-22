// packages/core/src/config/custom-tasks.test.ts
import { describe, it, expect } from "vitest";
import { parseAgentMd } from "./custom-tasks.js";

describe("parseAgentMd", () => {
  it("parses a full agent.md with all fields", () => {
    const content = `---
name: Code Review
description: Reviews code for quality
model: opus
permission_mode: acceptEdits
execution_mode: sdk
allowed_tools:
  - Read
  - Grep
disallowed_tools:
  - Bash
max_turns: 10
max_budget_usd: 5.0
setup:
  - bun install
teardown:
  - bun run clean
stage: pr
---
You are a code reviewer. Review the code carefully.
`;
    const result = parseAgentMd(content, "code-review");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Code Review");
    expect(result!.description).toBe("Reviews code for quality");
    expect(result!.model).toBe("opus");
    expect(result!.permissionMode).toBe("acceptEdits");
    expect(result!.executionMode).toBe("sdk");
    expect(result!.allowedTools).toEqual(["Read", "Grep"]);
    expect(result!.disallowedTools).toEqual(["Bash"]);
    expect(result!.maxTurns).toBe(10);
    expect(result!.maxBudgetUsd).toBe(5.0);
    expect(result!.setup).toEqual(["bun install"]);
    expect(result!.teardown).toEqual(["bun run clean"]);
    expect(result!.stage).toBe("pr");
    expect(result!.prompt).toBe("You are a code reviewer. Review the code carefully.");
  });

  it("derives name from directory slug when missing", () => {
    const content = `---
description: A task
---
Do the thing.
`;
    const result = parseAgentMd(content, "code-review");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Code Review");
    expect(result!.prompt).toBe("Do the thing.");
  });

  it("returns null for empty body", () => {
    expect(parseAgentMd("", "test-task")).toBeNull();
  });

  it("returns null for whitespace-only body", () => {
    expect(parseAgentMd("   \n\n  \t  ", "test-task")).toBeNull();
  });

  it("handles missing frontmatter entirely (whole content is the prompt)", () => {
    const content = "Just a prompt with no frontmatter.";
    const result = parseAgentMd(content, "my-task");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("My Task");
    expect(result!.prompt).toBe("Just a prompt with no frontmatter.");
    expect(result!.description).toBeUndefined();
    expect(result!.model).toBeUndefined();
    expect(result!.permissionMode).toBeUndefined();
  });

  it("ignores unknown frontmatter fields", () => {
    const content = `---
name: Known
unknown_field: hello
another_unknown: 42
---
The prompt.
`;
    const result = parseAgentMd(content, "test");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Known");
    expect(result!.prompt).toBe("The prompt.");
    expect((result as any).unknown_field).toBeUndefined();
    expect((result as any).unknownField).toBeUndefined();
    expect((result as any).another_unknown).toBeUndefined();
    expect((result as any).anotherUnknown).toBeUndefined();
  });

  it("falls back on type mismatches (bad max_turns)", () => {
    const content = `---
max_turns: not-a-number
---
Prompt.
`;
    const result = parseAgentMd(content, "test");
    expect(result).not.toBeNull();
    expect(result!.maxTurns).toBeUndefined();
    expect(result!.prompt).toBe("Prompt.");
  });

  it("falls back on type mismatches (bad setup)", () => {
    const content = `---
setup: not-an-array
---
Prompt.
`;
    const result = parseAgentMd(content, "test");
    expect(result).not.toBeNull();
    expect(result!.setup).toBeUndefined();
  });

  it("falls back on type mismatches (bad permission_mode)", () => {
    const content = `---
permission_mode: invalid-mode
---
Prompt.
`;
    const result = parseAgentMd(content, "test");
    expect(result).not.toBeNull();
    expect(result!.permissionMode).toBeUndefined();
  });

  it("falls back on type mismatches (bad stage)", () => {
    const content = `---
stage: invalid-stage
---
Prompt.
`;
    const result = parseAgentMd(content, "test");
    expect(result).not.toBeNull();
    expect(result!.stage).toBeUndefined();
  });

  it("handles empty frontmatter", () => {
    const content = `---
---
Prompt with empty frontmatter.
`;
    const result = parseAgentMd(content, "empty-fm");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Empty Fm");
    expect(result!.prompt).toBe("Prompt with empty frontmatter.");
  });

  it("returns null for malformed YAML", () => {
    const content = `---
name: [unterminated
  bad: yaml: here
---
Some prompt.
`;
    const result = parseAgentMd(content, "bad-yaml");
    expect(result).toBeNull();
  });
});
