// packages/core/src/config/custom-tasks.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NEW_CUSTOM_TASK_PROMPT, parseAgentMd } from "./custom-tasks.js";
import { scanCustomTasks } from "./custom-tasks-scanner.js";

describe("NEW_CUSTOM_TASK_PROMPT", () => {
  it("documents all supported agent providers without implying omitted-provider fallback behavior", () => {
    expect(NEW_CUSTOM_TASK_PROMPT).toContain('- agent_provider: "claude" | "copilot" | "codex"');
    expect(NEW_CUSTOM_TASK_PROMPT).not.toContain("uses app default when omitted");
  });
});

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

  it("accepts codex as an agent provider", () => {
    const content = `---
agent_provider: codex
---
Use Codex for this task.
`;
    const result = parseAgentMd(content, "codex-task");
    expect(result).not.toBeNull();
    expect(result!.agentProvider).toBe("codex");
    expect(result!.prompt).toBe("Use Codex for this task.");
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

describe("scanCustomTasks", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `kanna-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("scans a directory with valid custom tasks", async () => {
    const taskDir = join(tmpDir, ".kanna", "tasks", "ship");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      join(taskDir, "agent.md"),
      `---
name: Ship It
description: Ship the feature
permission_mode: dontAsk
---
Ship the code to production.
`,
    );

    const result = await scanCustomTasks(tmpDir);
    expect(result.errors).toHaveLength(0);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].name).toBe("Ship It");
    expect(result.tasks[0].description).toBe("Ship the feature");
    expect(result.tasks[0].permissionMode).toBe("dontAsk");
    expect(result.tasks[0].prompt).toBe("Ship the code to production.");
  });

  it("returns empty list when .kanna/tasks/ does not exist", async () => {
    const result = await scanCustomTasks(tmpDir);
    expect(result.tasks).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("returns empty list when .kanna/tasks/ is empty", async () => {
    mkdirSync(join(tmpDir, ".kanna", "tasks"), { recursive: true });
    const result = await scanCustomTasks(tmpDir);
    expect(result.tasks).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("skips directories without agent.md", async () => {
    const taskDir = join(tmpDir, ".kanna", "tasks", "no-agent");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "README.md"), "Not an agent file");

    const result = await scanCustomTasks(tmpDir);
    expect(result.tasks).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("reports errors for malformed agent.md (bad YAML)", async () => {
    const taskDir = join(tmpDir, ".kanna", "tasks", "bad-yaml");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      join(taskDir, "agent.md"),
      `---
name: [unterminated
  bad: yaml: here
---
Some prompt.
`,
    );

    const result = await scanCustomTasks(tmpDir);
    expect(result.tasks).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].path).toContain("bad-yaml");
    expect(result.errors[0].path).toContain("agent.md");
    expect(result.errors[0].error).toContain("Failed to parse");
  });

  it("handles mix of valid and invalid tasks", async () => {
    // Valid task
    const validDir = join(tmpDir, ".kanna", "tasks", "valid-task");
    mkdirSync(validDir, { recursive: true });
    writeFileSync(
      join(validDir, "agent.md"),
      `---
name: Valid Task
---
Do the valid thing.
`,
    );

    // Invalid task (bad YAML)
    const invalidDir = join(tmpDir, ".kanna", "tasks", "invalid-task");
    mkdirSync(invalidDir, { recursive: true });
    writeFileSync(
      join(invalidDir, "agent.md"),
      `---
name: [broken
---
Prompt.
`,
    );

    // Directory without agent.md (should be silently skipped)
    const noAgentDir = join(tmpDir, ".kanna", "tasks", "no-agent");
    mkdirSync(noAgentDir, { recursive: true });
    writeFileSync(join(noAgentDir, "notes.txt"), "just notes");

    const result = await scanCustomTasks(tmpDir);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].name).toBe("Valid Task");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].path).toContain("invalid-task");
  });

  it("skips agent.md with no prompt body silently (no error)", async () => {
    const taskDir = join(tmpDir, ".kanna", "tasks", "empty-body");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      join(taskDir, "agent.md"),
      `---
name: No Body Task
description: Has frontmatter but no prompt
---
`,
    );

    const result = await scanCustomTasks(tmpDir);
    expect(result.tasks).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("supports cancellation via AbortSignal (pre-aborted)", async () => {
    // Create a valid task that would normally be found
    const taskDir = join(tmpDir, ".kanna", "tasks", "should-skip");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      join(taskDir, "agent.md"),
      `---
name: Should Skip
---
This should not appear.
`,
    );

    const controller = new AbortController();
    controller.abort(); // Pre-abort

    const result = await scanCustomTasks(tmpDir, controller.signal);
    expect(result.tasks).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});
