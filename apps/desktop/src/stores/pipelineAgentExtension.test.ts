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

  it("loads an explicit built-in flavor", async () => {
    mockAgentFiles({
      "builtin:.kanna/agents/pr/flavors/push-only/AGENT.md": `---
name: pr@push-only
description: Pushes only
agent_provider: claude
---

Push only.
`,
    });

    const agent = await makeApi().loadAgent("/repo", "pr@push-only");
    expect(agent.name).toBe("pr@push-only");
    expect(agent.prompt).toBe("Push only.");
  });

  it("prefers a repo agent override over an explicit built-in flavor", async () => {
    mockAgentFiles({
      "/repo/.kanna/agents/pr/AGENT.md": BASE_AGENT_MD,
      "builtin:.kanna/agents/pr/flavors/push-only/AGENT.md": `---
name: pr@push-only
description: Push only
agent_provider: claude
---

Push only.
`,
    });

    const agent = await makeApi().loadAgent("/repo", "pr@push-only");
    expect(agent.name).toBe("review");
    expect(agent.prompt).toBe("Review the branch.");
  });

  it("layers the role extension onto an explicit built-in flavor", async () => {
    mockAgentFiles({
      "builtin:.kanna/agents/pr/flavors/push-only/AGENT.md": `---
name: pr@push-only
description: Push only
agent_provider: claude
---

Push only.
`,
      "/repo/.kanna/agents/pr/EXTEND.md": "Repo rule: publish only after local CI passes.",
    });

    const agent = await makeApi().loadAgent("/repo", "pr@push-only");
    expect(agent.name).toBe("pr@push-only");
    expect(agent.prompt).toBe("Push only.\n\nRepo rule: publish only after local CI passes.");
  });

  it("uses the repo config flavor map before the built-in default", async () => {
    mockAgentFiles({
      "/repo/.kanna/config.json": JSON.stringify({ flavors: { merge: "git" } }),
      "builtin:.kanna/agents/merge/flavors/git/AGENT.md": `---
name: merge@git
description: Git merge
agent_provider: claude
---

Git-only merge.
`,
      "builtin:.kanna/agents/merge/AGENT.md": `---
name: merge
description: Default merge
agent_provider: claude
---

Default merge.
`,
    });

    const agent = await makeApi().loadAgent("/repo", "merge");
    expect(agent.name).toBe("merge@git");
    expect(agent.prompt).toBe("Git-only merge.");
  });

  it("prefers a repo agent override over a configured flavor", async () => {
    mockAgentFiles({
      "/repo/.kanna/config.json": JSON.stringify({ flavors: { pr: "push-only" } }),
      "/repo/.kanna/agents/pr/AGENT.md": BASE_AGENT_MD,
      "builtin:.kanna/agents/pr/flavors/push-only/AGENT.md": `---
name: pr@push-only
description: Push only
agent_provider: claude
---

Push only.
`,
    });

    const agent = await makeApi().loadAgent("/repo", "pr");
    expect(agent.name).toBe("review");
    expect(agent.prompt).toBe("Review the branch.");
  });

  it("leaves repo config vars in the loaded agent body for server-side substitution", async () => {
    // Config-var substitution happens in a single pass server-side
    // (kanna-server read_agent_definition/build_stage_prompt); the frontend
    // loader must return the raw body so vars are never expanded twice.
    mockAgentFiles({
      "/repo/.kanna/config.json": JSON.stringify({
        vars: { KANNA_TASK_ID: "config-task", REVIEW_TEAM: "platform", MERGE_STRATEGY: "squash" },
      }),
      "/repo/.kanna/agents/review/AGENT.md": `---
name: review
description: Reviews branches
agent_provider: claude
---

Use $MERGE_STRATEGY for ${"${REVIEW_TEAM}"}. Keep $BASE_REF and $KANNA_TASK_ID runtime-bound.
`,
    });

    const agent = await makeApi().loadAgent("/repo", "review");
    expect(agent.prompt).toBe(
      `Use $MERGE_STRATEGY for ${"${REVIEW_TEAM}"}. Keep $BASE_REF and $KANNA_TASK_ID runtime-bound.`,
    );
  });
});
