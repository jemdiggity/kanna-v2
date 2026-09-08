// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import FilePickerModal from "../FilePickerModal.vue";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("../../invoke", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("../../composables/useToast", () => ({
  useToast: () => ({ warning: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

async function settle() {
  for (let round = 0; round < 4; round += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

function listedPaths(wrapper: ReturnType<typeof mount>): string[] {
  return wrapper.findAll(".file-item").map((item) => item.text());
}

describe("FilePickerModal", () => {
  afterEach(() => {
    invokeMock.mockReset();
  });

  it("lists the worktree's files", async () => {
    invokeMock.mockResolvedValue(["README.md", "src/index.txt"]);
    const wrapper = mount(FilePickerModal, {
      props: { worktreePath: "/repo-a", repoRoot: "/repo-a" },
      global: { mocks: { $t: (key: string) => key } },
    });
    await settle();

    expect(listedPaths(wrapper)).toEqual(["README.md", "src/index.txt"]);
  });

  it("reloads when the path it points at changes", async () => {
    // The picker stays mounted while hidden, so without this it keeps showing
    // the first path's listing — another repo's files, or nothing at all when
    // that first load pointed at a path that had gone away.
    invokeMock.mockRejectedValueOnce(new Error("not a directory: /gone"));
    const wrapper = mount(FilePickerModal, {
      props: { worktreePath: "/gone", repoRoot: "/gone" },
      global: { mocks: { $t: (key: string) => key } },
    });
    await settle();
    expect(listedPaths(wrapper)).toEqual([]);

    invokeMock.mockResolvedValue(["README.md", "src/index.txt"]);
    await wrapper.setProps({ worktreePath: "/repo-b", repoRoot: "/repo-b" });
    await settle();

    expect(listedPaths(wrapper)).toEqual(["README.md", "src/index.txt"]);
  });
});
