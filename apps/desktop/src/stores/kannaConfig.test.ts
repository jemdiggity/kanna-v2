// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineItem, Repo } from "../types/kanna";
import {
  setDesktopServerClientHandlersForTests,
  updateDesktopServerClientHandlersForTests,
} from "../services/desktopServerClient";
import { collectTeardownCommands, fetchRepoConfig } from "./kanna";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    throw new Error(`unexpected invoke: ${command} ${JSON.stringify(args)}`);
  }),
}));

vi.mock("../invoke", () => ({
  invoke: invokeMock,
}));

const item = {
  id: "task-123",
  repo_id: "repo-1",
  branch: "task-123",
  display_name: null,
} as PipelineItem;

const repo = {
  id: "repo-1",
  path: "/repo",
  name: "repo",
  default_branch: "main",
  hidden: 0,
} as Repo;

describe("task lifecycle config resolution", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      throw new Error(`unexpected invoke: ${command} ${JSON.stringify(args)}`);
    });
    updateDesktopServerClientHandlersForTests({
      fetchRepoKannaDefinitions: async () => ({
        revision: "remote-rev",
        refName: "origin/main",
        config: {},
        defaultPipeline: "default",
        pipelines: ["default"],
      }),
    });
  });

  afterEach(() => {
    setDesktopServerClientHandlersForTests(null);
  });

  it("loads repo config from the repo definitions manifest by repo ID", async () => {
    const config = {
      setup: ["remote setup"],
      workspace: { env: { REMOTE_ENV: "yes" } },
    };
    const fetchRepoKannaDefinitions = vi.fn(async () => ({
      revision: "remote-rev",
      refName: "origin/main",
      config,
      defaultPipeline: "default",
      pipelines: ["default"],
    }));
    updateDesktopServerClientHandlersForTests({ fetchRepoKannaDefinitions });

    await expect(fetchRepoConfig("repo-1")).resolves.toBe(config);

    expect(fetchRepoKannaDefinitions).toHaveBeenCalledWith("repo-1");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("propagates manifest errors without reading a local config", async () => {
    const error = new Error("remote config unavailable");
    updateDesktopServerClientHandlersForTests({
      fetchRepoKannaDefinitions: async () => {
        throw error;
      },
    });

    await expect(fetchRepoConfig("repo-1")).rejects.toBe(error);

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("keeps custom task teardown local and appends remote repo teardown", async () => {
    const fetchRepoKannaDefinitions = vi.fn(async () => ({
      revision: "remote-rev",
      refName: "origin/main",
      config: { teardown: ["remote teardown"] },
      defaultPipeline: "default",
      pipelines: ["default"],
    }));
    updateDesktopServerClientHandlersForTests({ fetchRepoKannaDefinitions });
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "list_dir" && args?.path === "/repo/.kanna/tasks") {
        return ["release"];
      }
      if (command === "read_text_file" && args?.path === "/repo/.kanna/tasks/release/agent.md") {
        return `---
name: Release
teardown:
  - custom teardown
---
Release the task.
`;
      }
      throw new Error(`unexpected invoke: ${command} ${JSON.stringify(args)}`);
    });

    await expect(collectTeardownCommands(
      { ...item, display_name: "Release" } as PipelineItem,
      repo,
    )).resolves.toEqual(["custom teardown", "remote teardown"]);

    expect(fetchRepoKannaDefinitions).toHaveBeenCalledWith("repo-1");
    expect(invokeMock).not.toHaveBeenCalledWith(
      "read_text_file",
      expect.objectContaining({ path: expect.stringContaining("/.kanna/config.json") }),
    );
  });

  it("propagates teardown manifest errors without a local config fallback", async () => {
    const error = new Error("remote teardown unavailable");
    updateDesktopServerClientHandlersForTests({
      fetchRepoKannaDefinitions: async () => {
        throw error;
      },
    });

    await expect(collectTeardownCommands(item, repo)).rejects.toBe(error);

    expect(invokeMock).not.toHaveBeenCalled();
  });
});
