// @vitest-environment happy-dom

import { nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCustomTasks } from "./useCustomTasks";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn<
    (command: string, args?: { path?: string; relativePath?: string }) => Promise<unknown>
  >(),
}));

vi.mock("../invoke", () => ({
  invoke: invokeMock,
}));

async function flushPromises() {
  await Promise.resolve();
  await nextTick();
}

describe("useCustomTasks", () => {
  afterEach(() => {
    invokeMock.mockReset();
  });

  it("loads bundled built-in tasks when the repo has no .kanna/tasks directory", async () => {
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "list_builtin_resources" && args?.relativePath === ".kanna/tasks") {
        return ["merge-master"];
      }
      if (command === "read_builtin_resource" && args?.relativePath === ".kanna/tasks/merge-master/agent.md") {
        return `---
name: Merge Master
description: Built-in merge task
agent: merge
---
`;
      }
      if (command === "list_dir" && args?.path === "/repo/.kanna/tasks") {
        throw new Error("missing");
      }
      throw new Error(`unexpected invoke: ${command} ${JSON.stringify(args)}`);
    });

    const { tasks, scan } = useCustomTasks();
    await scan("/repo");
    await flushPromises();

    expect(tasks.value).toHaveLength(1);
    expect(tasks.value[0]).toMatchObject({
      name: "Merge Master",
      description: "Built-in merge task",
      agent: "merge",
      prompt: "",
    });
  });

  it("lets repo custom tasks override bundled tasks with the same slug", async () => {
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "list_builtin_resources" && args?.relativePath === ".kanna/tasks") {
        return ["merge-master"];
      }
      if (command === "read_builtin_resource" && args?.relativePath === ".kanna/tasks/merge-master/agent.md") {
        return `---
name: Merge Master
description: Built-in merge task
---
Built-in prompt.
`;
      }
      if (command === "list_dir" && args?.path === "/repo/.kanna/tasks") {
        return ["merge-master"];
      }
      if (command === "read_text_file" && args?.path === "/repo/.kanna/tasks/merge-master/agent.md") {
        return `---
name: Merge Master
description: Repo override
---
Repo prompt.
`;
      }
      throw new Error(`unexpected invoke: ${command} ${JSON.stringify(args)}`);
    });

    const { tasks, scan } = useCustomTasks();
    await scan("/repo");
    await flushPromises();

    expect(tasks.value).toHaveLength(1);
    expect(tasks.value[0]).toMatchObject({
      name: "Merge Master",
      description: "Repo override",
      prompt: "Repo prompt.",
    });
  });
});
