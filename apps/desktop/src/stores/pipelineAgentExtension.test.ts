// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { createPipelineApi } from "./pipeline";
import type { StoreContext } from "./state";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    throw new Error(`unexpected invoke: ${command} ${JSON.stringify(args)}`);
  }),
}));

vi.mock("../invoke", () => ({
  invoke: invokeMock,
}));

const BASE_AGENT_MD = `---
name: review
description: Reviews branches
model: sonnet
agent_provider: claude
---

Review the branch.
`;

function makeApi() {
  const context = {
    state: {
      pipelineCache: new Map(),
      agentCache: new Map(),
    },
  } as unknown as StoreContext;
  return createPipelineApi(context);
}

function mockAgentFiles(files: Record<string, string>): void {
  invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    const path = typeof args?.path === "string" ? args.path : undefined;
    const relativePath = typeof args?.relativePath === "string" ? args.relativePath : undefined;
    if (command === "read_text_file" && path !== undefined && files[path] !== undefined) {
      return files[path];
    }
    if (command === "read_builtin_resource" && relativePath !== undefined && files[`builtin:${relativePath}`] !== undefined) {
      return files[`builtin:${relativePath}`];
    }
    throw new Error(`not found: ${command} ${JSON.stringify(args)}`);
  });
}

describe("loadAgent with repo extensions", () => {
  afterEach(() => {
    invokeMock.mockReset();
  });

  it("returns the base agent unchanged when no EXTEND.md exists", async () => {
    mockAgentFiles({
      "/repo/.kanna/agents/review/AGENT.md": BASE_AGENT_MD,
    });

    const agent = await makeApi().loadAgent("/repo", "review");
    expect(agent.prompt).toBe("Review the branch.");
    expect(agent.model).toBe("sonnet");
  });

  it("appends the repo extension body and applies frontmatter overrides", async () => {
    mockAgentFiles({
      "/repo/.kanna/agents/review/AGENT.md": BASE_AGENT_MD,
      "/repo/.kanna/agents/review/EXTEND.md": `---
model: opus
---

Run the full unit and integration suites.
`,
    });

    const agent = await makeApi().loadAgent("/repo", "review");
    expect(agent.prompt).toBe("Review the branch.\n\nRun the full unit and integration suites.");
    expect(agent.model).toBe("opus");
    expect(agent.name).toBe("review");
  });

  it("applies the repo extension on top of the builtin fallback when the repo has no AGENT.md", async () => {
    mockAgentFiles({
      "builtin:.kanna/agents/review/AGENT.md": BASE_AGENT_MD,
      "/repo/.kanna/agents/review/EXTEND.md": "Repo rule: run everything.",
    });

    const agent = await makeApi().loadAgent("/repo", "review");
    expect(agent.prompt).toBe("Review the branch.\n\nRepo rule: run everything.");
  });

  it("rejects an invalid extension with the extension path in the error", async () => {
    mockAgentFiles({
      "/repo/.kanna/agents/review/AGENT.md": BASE_AGENT_MD,
      "/repo/.kanna/agents/review/EXTEND.md": "---\npermission_mode: neverAsk\n---\n\nExtra.",
    });

    await expect(makeApi().loadAgent("/repo", "review")).rejects.toThrow(
      /Invalid agent extension at \/repo\/\.kanna\/agents\/review\/EXTEND\.md.*permission_mode/,
    );
  });

  it("caches the extended agent", async () => {
    mockAgentFiles({
      "/repo/.kanna/agents/review/AGENT.md": BASE_AGENT_MD,
      "/repo/.kanna/agents/review/EXTEND.md": "Extra rule.",
    });

    const api = makeApi();
    const first = await api.loadAgent("/repo", "review");
    invokeMock.mockClear();
    const second = await api.loadAgent("/repo", "review");
    expect(second).toBe(first);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
