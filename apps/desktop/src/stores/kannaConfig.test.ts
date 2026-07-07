// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PipelineItem, Repo } from "../types/kanna";
import { collectTeardownCommands, readRepoConfig } from "./kanna";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    throw new Error(`unexpected invoke: ${command} ${JSON.stringify(args)}`);
  }),
}));

vi.mock("../invoke", () => ({
  invoke: invokeMock,
}));

function mockRepoConfigResponse(basePath: string, config: Record<string, unknown>): void {
  const configPath = `${basePath}/.kanna/config.json`;
  invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "read_text_file" && args?.path === configPath) {
      return JSON.stringify(config);
    }
    throw new Error(`unexpected invoke: ${command} ${JSON.stringify(args)}`);
  });
}

describe("task lifecycle config resolution", () => {
  afterEach(() => {
    invokeMock.mockReset();
  });

  it("reads setup commands from the task worktree config instead of the repo root config", async () => {
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (
        command === "read_text_file" &&
        args?.path === "/repo/.kanna-worktrees/task-123/.kanna/config.json"
      ) {
        return JSON.stringify({ setup: ["pnpm install"] });
      }
      if (command === "read_text_file" && args?.path === "/repo/.kanna/config.json") {
        throw new Error("repo root config should not be read for task setup");
      }
      throw new Error(`unexpected invoke: ${command} ${JSON.stringify(args)}`);
    });

    await expect(readRepoConfig("/repo/.kanna-worktrees/task-123")).resolves.toEqual({
      setup: ["pnpm install"],
    });
  });

  it("reads teardown commands from the task worktree config", async () => {
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (
        command === "read_text_file" &&
        args?.path === "/repo/.kanna-worktrees/task-123/.kanna/config.json"
      ) {
        return JSON.stringify({ teardown: ["pnpm worktree-clean"] });
      }
      if (command === "read_text_file" && args?.path === "/repo/.kanna/config.json") {
        throw new Error("repo root config should not be read for task teardown");
      }
      if (command === "list_dir" && args?.path === "/repo/.kanna/tasks") {
        return [];
      }
      throw new Error(`unexpected invoke: ${command} ${JSON.stringify(args)}`);
    });

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

    await expect(collectTeardownCommands(item, repo)).resolves.toEqual(["pnpm worktree-clean"]);
  });

  it("treats missing worktree config as empty", async () => {
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (
        command === "read_text_file" &&
        args?.path === "/repo/.kanna-worktrees/task-123/.kanna/config.json"
      ) {
        throw new Error("failed to read '/repo/.kanna-worktrees/task-123/.kanna/config.json': No such file or directory");
      }
      throw new Error(`unexpected invoke: ${command} ${JSON.stringify(args)}`);
    });

    await expect(readRepoConfig("/repo/.kanna-worktrees/task-123")).resolves.toEqual({});
  });

  it("rejects invalid worktree config instead of treating it as empty", async () => {
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (
        command === "read_text_file" &&
        args?.path === "/repo/.kanna-worktrees/task-123/.kanna/config.json"
      ) {
        return '{ "setup": ["pnpm install", ], }';
      }
      throw new Error(`unexpected invoke: ${command} ${JSON.stringify(args)}`);
    });

    await expect(readRepoConfig("/repo/.kanna-worktrees/task-123")).rejects.toThrow(
      "invalid repo config '/repo/.kanna-worktrees/task-123/.kanna/config.json'",
    );
  });
});
