// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import AddRepoModal from "../AddRepoModal.vue";

interface LocalRepoFixture {
  exists: boolean;
  branch: string;
  hasCommits?: boolean;
  isGitRepo?: boolean;
  remote: string;
}

const localRepos = new Map<string, LocalRepoFixture>([
  [
    "/Users/me/code/project",
    {
      exists: true,
      branch: "main",
      remote: "git@github.com:owner/project.git",
    },
  ],
  [
    "/Users/me/code/design-system",
    {
      exists: true,
      branch: "trunk",
      remote: "git@github.com:owner/design-system.git",
    },
  ],
  [
    "/Users/me/code/second-project",
    {
      exists: true,
      branch: "main",
      remote: "git@github.com:owner/second-project.git",
    },
  ],
  [
    "/Users/me/code/not-a-repo",
    {
      exists: true,
      branch: "main",
      isGitRepo: false,
      remote: "",
    },
  ],
]);

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (command: string, args?: { path?: string; repoPath?: string }) => {
    const localPath = args?.path ?? args?.repoPath;
    const fixture = localPath ? localRepos.get(localPath) : undefined;

    if (command === "file_exists") {
      return fixture?.exists ?? false;
    }
    if (command === "git_repository_state" && fixture) {
      if (fixture.isGitRepo === false) throw new Error("not a git repository");
      return {
        defaultBranch: fixture.branch,
        hasCommits: fixture.hasCommits ?? true,
      };
    }
    if (command === "git_remote_url" && fixture) {
      return fixture.remote;
    }
    return false;
  }),
}));

vi.mock("../../invoke", () => ({
  invoke: invokeMock,
}));

vi.mock("../../dialog", () => ({
  open: vi.fn(),
}));

vi.mock("../../composables/useModalZIndex", () => ({
  useModalZIndex: () => ({ zIndex: 1 }),
}));

vi.mock("@tauri-apps/api/path", () => ({
  homeDir: vi.fn(async () => "/Users/me"),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

async function flushPromises() {
  await vi.dynamicImportSettled();
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

function mountModal(initialTab: "create" | "import" = "import") {
  return mount(AddRepoModal, {
    props: {
      initialTab,
    },
    attachTo: document.body,
    global: {
      mocks: {
        $t: (key: string) => key,
      },
    },
  });
}

describe("AddRepoModal", () => {
  afterEach(() => {
    invokeMock.mockClear();
  });

  it("imports a repo from a pasted absolute path", async () => {
    const wrapper = mountModal();

    await flushPromises();

    await wrapper.get('input[type="text"]').setValue("/Users/me/code/project");
    await flushPromises();

    expect(wrapper.text()).toContain("addRepo.gitRepoConfirmed");

    await wrapper.get(".btn-primary").trigger("click");

    expect(wrapper.emitted("import")).toEqual([
      ["/Users/me/code/project", "project", "main"],
    ]);
  });

  it("preserves an empty repository's configured initial branch", async () => {
    localRepos.set("/Users/me/code/empty-project", {
      exists: true,
      branch: "trunk",
      hasCommits: false,
      remote: "",
    });
    const wrapper = mountModal();

    await flushPromises();
    await wrapper.get('input[type="text"]').setValue("/Users/me/code/empty-project");
    await flushPromises();
    await wrapper.get(".btn-primary").trigger("click");

    expect(wrapper.emitted("import")).toEqual([
      ["/Users/me/code/empty-project", "empty-project", "trunk"],
    ]);
  });

  it("keeps an existing non-repository path disabled", async () => {
    const wrapper = mountModal();

    await flushPromises();
    await wrapper.get('input[type="text"]').setValue("/Users/me/code/not-a-repo");
    await flushPromises();

    expect(wrapper.text()).toContain("addRepo.notAGitRepo");
    expect(wrapper.get(".btn-primary").attributes("disabled")).toBeDefined();
    await wrapper.get(".btn-primary").trigger("click");
    expect(wrapper.emitted("import")).toBeUndefined();
  });

  it("creates a repo with Cmd+Enter in the name input", async () => {
    const wrapper = mountModal("create");

    await flushPromises();

    const createInput = wrapper.get('input[placeholder="addRepo.namePlaceholder"]');
    await createInput.setValue("my-app");
    await createInput.trigger("keydown", { key: "Enter", metaKey: true });
    await flushPromises();

    expect(wrapper.emitted("create")).toEqual([
      ["my-app", "/Users/me/.kanna/repos/my-app"],
    ]);
  });

  it("rejects spaces in new repo names", async () => {
    const wrapper = mountModal("create");

    await flushPromises();

    const createInput = wrapper.get('input[placeholder="addRepo.namePlaceholder"]');
    await createInput.setValue("my app");
    await flushPromises();

    expect(wrapper.text()).toContain("addRepo.nameNoSpaces");
    expect(wrapper.get(".btn-primary").attributes("disabled")).toBeDefined();

    await wrapper.get(".btn-primary").trigger("click");
    await createInput.trigger("keydown", { key: "Enter", metaKey: true });
    await flushPromises();

    expect(wrapper.emitted("create")).toBeUndefined();
  });

  it("clones a repo with Cmd+Enter in the import input", async () => {
    const wrapper = mountModal();

    await flushPromises();

    const importInput = wrapper.get('input[placeholder="addRepo.importPlaceholder"]');
    await importInput.setValue("owner/repo");
    await importInput.trigger("keydown", { key: "Enter", metaKey: true });
    await flushPromises();

    expect(wrapper.emitted("clone")).toEqual([
      ["https://github.com/owner/repo.git", "/Users/me/.kanna/repos/repo"],
    ]);
  });

  it("expands a pasted tilde path before importing", async () => {
    const wrapper = mountModal();

    await flushPromises();

    await wrapper.get('input[type="text"]').setValue("~/code/project");
    await flushPromises();

    await wrapper.get(".btn-primary").trigger("click");

    expect(invokeMock).toHaveBeenCalledWith("file_exists", { path: "/Users/me/code/project" });
    expect(wrapper.emitted("import")).toEqual([
      ["/Users/me/code/project", "project", "main"],
    ]);
  });

  it("collapses the local repo name behind an explicit change link", async () => {
    const wrapper = mountModal();

    await flushPromises();

    const importInput = wrapper.get('input[placeholder="addRepo.importPlaceholder"]');
    await importInput.setValue("/Users/me/code/project");
    await flushPromises();

    expect(wrapper.find('input[placeholder="addRepo.repoNamePlaceholder"]').exists()).toBe(false);

    const repoNameRow = wrapper.get(".repo-name-row");
    expect(repoNameRow.find(".repo-name-label").text()).toBe("addRepo.repoNameLabel");
    expect(repoNameRow.find(".repo-name-value").text()).toBe("project");
    expect(repoNameRow.find(".repo-name-change").text()).toBe("addRepo.change");

    await repoNameRow.get(".repo-name-change").trigger("click");
    await flushPromises();

    const repoNameInput = wrapper.get('input[placeholder="addRepo.repoNamePlaceholder"]');
    expect(document.activeElement).toBe(repoNameInput.element);
    expect(repoNameInput.element.selectionStart).toBe(0);
    expect(repoNameInput.element.selectionEnd).toBe("project".length);

    await repoNameInput.setValue("Project Desktop");
    await repoNameInput.trigger("keydown", { key: "Enter" });
    await flushPromises();

    expect(wrapper.find('input[placeholder="addRepo.repoNamePlaceholder"]').exists()).toBe(false);
    expect(wrapper.get(".repo-name-value").text()).toBe("Project Desktop");

    await wrapper.get(".btn-primary").trigger("click");

    expect(wrapper.emitted("import")).toEqual([
      ["/Users/me/code/project", "Project Desktop", "main"],
    ]);
  });

  it("imports a local repo rename with Cmd+Enter in rename mode", async () => {
    const wrapper = mountModal();

    await flushPromises();

    const importInput = wrapper.get('input[placeholder="addRepo.importPlaceholder"]');
    await importInput.setValue("/Users/me/code/project");
    await flushPromises();

    await wrapper.get(".repo-name-change").trigger("click");
    await flushPromises();

    const repoNameInput = wrapper.get('input[placeholder="addRepo.repoNamePlaceholder"]');
    await repoNameInput.setValue("Project Desktop");
    await repoNameInput.trigger("keydown", { key: "Enter", metaKey: true });
    await flushPromises();

    expect(wrapper.emitted("import")).toEqual([
      ["/Users/me/code/project", "Project Desktop", "main"],
    ]);
  });

  it("keeps the committed local repo name when rename mode is canceled with Escape", async () => {
    const wrapper = mountModal();

    await flushPromises();

    const importInput = wrapper.get('input[placeholder="addRepo.importPlaceholder"]');
    await importInput.setValue("/Users/me/code/project");
    await flushPromises();

    const repoNameRow = wrapper.get(".repo-name-row");
    await repoNameRow.get(".repo-name-change").trigger("click");
    await flushPromises();

    const repoNameInput = wrapper.get('input[placeholder="addRepo.repoNamePlaceholder"]');
    await repoNameInput.setValue("Project Desktop");
    await repoNameInput.trigger("keydown", { key: "Enter" });
    await flushPromises();

    await repoNameRow.get(".repo-name-change").trigger("click");
    await flushPromises();

    const renameInput = wrapper.get('input[placeholder="addRepo.repoNamePlaceholder"]');
    await renameInput.setValue("Temporary Name");
    await renameInput.trigger("keydown", { key: "Escape" });
    await flushPromises();

    expect(wrapper.get(".repo-name-value").text()).toBe("Project Desktop");

    await wrapper.get(".btn-primary").trigger("click");

    expect(wrapper.emitted("import")).toEqual([
      ["/Users/me/code/project", "Project Desktop", "main"],
    ]);
  });

  it("falls back to the derived local repo name and resets when the path changes", async () => {
    const wrapper = mountModal();

    await flushPromises();

    const importInput = wrapper.get('input[placeholder="addRepo.importPlaceholder"]');
    await importInput.setValue("/Users/me/code/project");
    await flushPromises();

    const repoNameRow = wrapper.get(".repo-name-row");
    await repoNameRow.get(".repo-name-change").trigger("click");
    await flushPromises();

    const repoNameInput = wrapper.get('input[placeholder="addRepo.repoNamePlaceholder"]');
    await repoNameInput.setValue("");
    await repoNameInput.trigger("blur");
    await flushPromises();

    expect(wrapper.get(".repo-name-value").text()).toBe("project");

    await importInput.setValue("/Users/me/code/second-project");
    await flushPromises();

    expect(wrapper.get(".repo-name-value").text()).toBe("second-project");
  });

  it("preserves a custom rename when the same local repo is re-inspected with a trailing slash", async () => {
    const wrapper = mountModal();

    await flushPromises();

    const importInput = wrapper.get('input[placeholder="addRepo.importPlaceholder"]');
    await importInput.setValue("/Users/me/code/project");
    await flushPromises();

    const repoNameRow = wrapper.get(".repo-name-row");
    await repoNameRow.get(".repo-name-change").trigger("click");
    await flushPromises();

    const repoNameInput = wrapper.get('input[placeholder="addRepo.repoNamePlaceholder"]');
    await repoNameInput.setValue("Project Desktop");
    await repoNameInput.trigger("keydown", { key: "Enter" });
    await flushPromises();

    await importInput.setValue("/Users/me/code/project/");
    await flushPromises();

    expect(wrapper.get(".repo-name-value").text()).toBe("Project Desktop");
  });

  it("keeps focus on the import input until rename mode is opened explicitly", async () => {
    const wrapper = mountModal("create");

    await flushPromises();

    const createInput = wrapper.get('input[placeholder="addRepo.namePlaceholder"]');
    const tabs = wrapper.findAll("button.tab");
    const createTab = tabs[0];
    const importTab = tabs[1];

    createInput.element.focus();
    await flushPromises();
    expect(document.activeElement).toBe(createInput.element);

    const importMouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    importTab.element.dispatchEvent(importMouseDown);
    expect(importMouseDown.defaultPrevented).toBe(true);

    await importTab.trigger("click");
    await flushPromises();

    const importInput = wrapper.get('input[placeholder="addRepo.importPlaceholder"]');
    expect(document.activeElement).toBe(importInput.element);

    await importInput.setValue("/Users/me/code/project");
    await flushPromises();

    expect(document.activeElement).toBe(importInput.element);
    expect(wrapper.find('input[placeholder="addRepo.repoNamePlaceholder"]').exists()).toBe(false);

    await wrapper.get(".repo-name-change").trigger("click");
    await flushPromises();

    expect(document.activeElement).toBe(wrapper.get('input[placeholder="addRepo.repoNamePlaceholder"]').element);

    const createMouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    createTab.element.dispatchEvent(createMouseDown);
    expect(createMouseDown.defaultPrevented).toBe(true);

    await createTab.trigger("click");
    await flushPromises();

    expect(document.activeElement).toBe(wrapper.get('input[placeholder="addRepo.namePlaceholder"]').element);

    wrapper.unmount();
  });
});
