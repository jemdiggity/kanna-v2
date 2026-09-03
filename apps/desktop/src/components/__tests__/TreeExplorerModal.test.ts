// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import TreeExplorerModal from "../TreeExplorerModal.vue";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("../../invoke", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

async function settle() {
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

describe("TreeExplorerModal task roots", () => {
  afterEach(() => {
    invokeMock.mockReset();
  });

  it("lists a remote owner task without reading the local filesystem", async () => {
    const remoteDirectoryLoader = vi.fn(async () => ({
      entries: [
        { name: "src", path: "src", isDir: true },
        { name: "README.md", path: "README.md", isDir: false },
      ],
    }));
    const wrapper = mount(TreeExplorerModal, {
      props: {
        worktreePath: "task-owner-branch",
        repoRoot: "task-owner-branch",
        remoteDirectoryLoader,
      },
    });

    await settle();

    expect(remoteDirectoryLoader).toHaveBeenCalledWith("", false);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("README.md");
    expect(wrapper.text()).not.toContain("(empty)");
    wrapper.unmount();
  });

  it("shows a missing local worktree as unavailable without falling back to the repo", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    invokeMock.mockRejectedValue(new Error("not a directory"));
    const wrapper = mount(TreeExplorerModal, {
      props: {
        worktreePath: "/repo/.kanna-worktrees/task-removed",
        repoRoot: "/repo",
      },
    });

    await settle();

    expect(wrapper.get('[data-testid="tree-explorer-unavailable"]').text()).toContain(
      "Task files unavailable: not a directory",
    );
    expect(invokeMock).toHaveBeenCalledWith("read_dir_entries", {
      path: "/repo/.kanna-worktrees/task-removed",
      repoRoot: "/repo",
      showAllFiles: false,
    });
    expect(invokeMock).not.toHaveBeenCalledWith(
      "read_dir_entries",
      expect.objectContaining({ path: "/repo" }),
    );
    expect(wrapper.text()).not.toContain("(empty)");
    consoleError.mockRestore();
    wrapper.unmount();
  });
});
