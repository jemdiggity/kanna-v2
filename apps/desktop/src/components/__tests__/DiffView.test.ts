// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import DiffView from "../DiffView.vue";
import { clearContextShortcuts, resetContext } from "../../composables/useShortcutContext";
import en from "../../i18n/locales/en.json";

const invokeMock = vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>();
const setLanguageOverrideMock = vi.fn((fileMeta: { [key: string]: unknown }, lang: string) => ({
  ...fileMeta,
  languageOverride: lang,
}));
const renderMock = vi.fn();

interface MockSearchRow {
  lineIndex: string;
  text: string;
}

interface MockFileDiff {
  oldName?: string;
  newName?: string;
  name?: string;
  __searchRows?: MockSearchRow[];
  __deferPostRender?: boolean;
  __postRenderDelayMs?: number;
}

const diffMocks = vi.hoisted(() => ({
  actualParsePatchFiles: undefined as undefined | typeof import("@pierre/diffs").parsePatchFiles,
  parsePatchFilesMock: vi.fn<(typeof import("@pierre/diffs"))["parsePatchFiles"]>(),
}));
const workerPoolOptionsMock = vi.hoisted(() => vi.fn());

vi.mock("../../invoke", () => ({
  invoke: (...args: [string, Record<string, unknown> | undefined]) => invokeMock(...args),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key.split(".").reduce<unknown>((value, part) => {
      if (typeof value === "object" && value !== null && part in value) {
        return (value as Record<string, unknown>)[part];
      }
      return undefined;
    }, en) ?? key,
  }),
}));

vi.mock("@pierre/diffs", async () => {
  const actual = await vi.importActual<typeof import("@pierre/diffs")>("@pierre/diffs");
  diffMocks.actualParsePatchFiles = actual.parsePatchFiles;
  diffMocks.parsePatchFilesMock.mockImplementation(actual.parsePatchFiles);
  return {
    ...actual,
    parsePatchFiles: (...args: Parameters<typeof actual.parsePatchFiles>) => diffMocks.parsePatchFilesMock(...args),
    FileDiff: class {
      private options?: { onPostRender?: () => void };

      constructor(options?: { onPostRender?: () => void }) {
        this.options = options;
      }

      render = (...args: [Record<string, unknown>]) => {
        const [{ containerWrapper, fileDiff }] = args;
        const wrapper = containerWrapper as HTMLElement | undefined;
        const diffMeta = fileDiff as MockFileDiff | undefined;

        if (wrapper && diffMeta) {
          const container = document.createElement("diffs-container");
          const shadowRoot = container.attachShadow({ mode: "open" });
          const header = diffMeta.newName ?? diffMeta.oldName ?? diffMeta.name ?? "";
          const rows = diffMeta.__searchRows ?? [];

          shadowRoot.innerHTML = `
            <div data-title="">${header}</div>
            <div data-gutter="">
              ${rows.map((row) => `<div data-line-index="${row.lineIndex}">${row.lineIndex}</div>`).join("")}
            </div>
            <div data-content="">
              ${rows.map((row) => `<div data-line-index="${row.lineIndex}">${row.text}</div>`).join("")}
            </div>
          `;

          wrapper.appendChild(container);
        }

        renderMock(...args);
        if (diffMeta?.__deferPostRender) {
          setTimeout(() => this.options?.onPostRender?.(), diffMeta.__postRenderDelayMs ?? 0);
        } else {
          this.options?.onPostRender?.();
        }
      };
    },
    setLanguageOverride: (...args: [Record<string, unknown>, string]) => setLanguageOverrideMock(...args),
  };
});

vi.mock("@pierre/diffs/worker", () => ({
  getOrCreateWorkerPoolSingleton: vi.fn((options) => {
    workerPoolOptionsMock(options);
    return {
      setRenderOptions: vi.fn(async () => {}),
    };
  }),
}));

async function flushPromises() {
  await Promise.resolve();
  await nextTick();
}

describe("DiffView", () => {
  afterEach(() => {
    invokeMock.mockReset();
    setLanguageOverrideMock.mockReset();
    diffMocks.parsePatchFilesMock.mockReset();
    if (diffMocks.actualParsePatchFiles) {
      diffMocks.parsePatchFilesMock.mockImplementation(diffMocks.actualParsePatchFiles);
    }
    renderMock.mockReset();
    workerPoolOptionsMock.mockReset();
    clearContextShortcuts("diff");
    resetContext();
    document.body.innerHTML = "";
  });

  it("uses the effective light code theme for diff rendering and worker highlighting", async () => {
    const { resetThemeRuntimeForTests, setSystemPrefersDark, setThemePreferences } = await import("../../theme/runtime");
    resetThemeRuntimeForTests();
    setSystemPrefersDark(false);
    setThemePreferences({ appTheme: "light", codeTheme: "match" });
    invokeMock.mockImplementation(async (command) => {
      if (command === "git_diff") return "diff --git a/example.ts b/example.ts";
      return "";
    });

    const wrapper = mount(DiffView, {
      props: {
        repoPath: "/repo",
        initialScope: "working",
      },
      attachTo: document.body,
      global: {
        mocks: {
          $t: (key: string) => key,
        },
      },
    });

    await flushPromises();
    await flushPromises();

    expect(workerPoolOptionsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        highlighterOptions: expect.objectContaining({ theme: "github-light" }),
      }),
    );
    expect(renderMock.mock.calls.at(-1)?.[0]).toBeDefined();

    wrapper.unmount();
    resetThemeRuntimeForTests();
  });

  it("labels the combined working diff filter as staged plus unstaged", async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === "git_diff") return "diff --git a/example.txt b/example.txt";
      return "";
    });

    const wrapper = mount(DiffView, {
      props: {
        repoPath: "/repo",
        initialScope: "working",
      },
      attachTo: document.body,
      global: {
        mocks: {
          $t: (key: string) => key,
        },
      },
    });

    await flushPromises();
    await flushPromises();

    expect(wrapper.get(".staged-toggle").text()).toBe("Staged+Unstaged");

    wrapper.unmount();
  });

  it("forces Bazel diffs to use python highlighting", async () => {
    diffMocks.parsePatchFilesMock.mockReturnValueOnce([
      {
        files: [
          {
            oldName: "BUILD.bazel",
            newName: "BUILD.bazel",
            hunks: [],
          },
        ],
      },
    ]);

    invokeMock.mockImplementation(async (command) => {
      if (command === "git_diff") return "diff --git a/BUILD.bazel b/BUILD.bazel";
      return "";
    });

    const wrapper = mount(DiffView, {
      props: {
        repoPath: "/repo",
        initialScope: "working",
      },
      attachTo: document.body,
      global: {
        mocks: {
          $t: (key: string) => key,
        },
      },
    });

    await flushPromises();
    await flushPromises();

    expect(setLanguageOverrideMock).toHaveBeenCalledWith(
      expect.objectContaining({
        oldName: "BUILD.bazel",
        newName: "BUILD.bazel",
      }),
      "python"
    );
    const renderArg = renderMock.mock.calls.at(-1)?.[0];
    expect(renderArg?.fileDiff).toMatchObject({
      oldName: "BUILD.bazel",
      newName: "BUILD.bazel",
      languageOverride: "python",
    });

    wrapper.unmount();
  });

  it("renders branch diffs with quoted Git patch paths", async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === "git_merge_base") return "abc123";
      if (command === "git_diff_branch_range") {
        return [
          'diff --git "a/file name.txt" "b/file name.txt"',
          "index 7898192..6178079 100644",
          '--- "a/file name.txt"',
          '+++ "b/file name.txt"',
          "@@ -1 +1 @@",
          "-before",
          "+after",
          "",
        ].join("\n");
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const wrapper = mount(DiffView, {
      props: {
        repoPath: "/repo",
        initialScope: "branch",
        baseRef: "origin/main",
      },
      attachTo: document.body,
      global: {
        mocks: {
          $t: (key: string) => key,
        },
      },
    });

    await flushPromises();
    await flushPromises();

    const renderArg = renderMock.mock.calls.at(-1)?.[0];
    expect(renderArg?.fileDiff).toMatchObject({
      name: "file name.txt",
    });

    wrapper.unmount();
  });

  it("uses the current branch upstream as the branch diff base when it differs from the stored base ref", async () => {
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "git_branch_upstream") return "origin/release";
      if (command === "git_merge_base") {
        expect(args?.refA).toBe("origin/release");
        return "release-base";
      }
      if (command === "git_diff_branch_range") return "diff --git a/rebased.txt b/rebased.txt";
      throw new Error(`unexpected command: ${command}`);
    });

    const wrapper = mount(DiffView, {
      props: {
        repoPath: "/repo",
        initialScope: "branch",
        baseRef: "origin/main",
      },
      attachTo: document.body,
      global: {
        mocks: {
          $t: (key: string) => key,
        },
      },
    });

    await flushPromises();
    await flushPromises();

    expect(invokeMock).toHaveBeenCalledWith("git_branch_upstream", { repoPath: "/repo" });
    expect(invokeMock).toHaveBeenCalledWith("git_merge_base", {
      repoPath: "/repo",
      refA: "origin/release",
      refB: "HEAD",
    });

    wrapper.unmount();
  });

  it("cycles branch include modes and reloads the branch diff", async () => {
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "git_branch_upstream") return null;
      if (command === "git_merge_base") return "base-sha";
      if (command === "git_diff_branch_range") {
        return `diff --git a/${args?.mode}.txt b/${args?.mode}.txt`;
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const wrapper = mount(DiffView, {
      props: {
        repoPath: "/repo",
        initialScope: "branch",
        baseRef: "origin/main",
      },
      attachTo: document.body,
      global: {
        mocks: {
          $t: (key: string) => key,
        },
      },
    });

    await flushPromises();
    await flushPromises();

    expect(invokeMock).toHaveBeenCalledWith("git_diff_branch_range", {
      repoPath: "/repo",
      from: "base-sha",
      mode: "none",
    });

    const includeButton = wrapper.get(".branch-include-toggle");
    expect(includeButton.text()).toBe("None");

    await includeButton.trigger("click");
    await flushPromises();
    await flushPromises();

    expect(invokeMock).toHaveBeenCalledWith("git_diff_branch_range", {
      repoPath: "/repo",
      from: "base-sha",
      mode: "staged",
    });
    expect(includeButton.text()).toBe("Staged");

    await includeButton.trigger("click");
    await flushPromises();
    await flushPromises();

    expect(invokeMock).toHaveBeenCalledWith("git_diff_branch_range", {
      repoPath: "/repo",
      from: "base-sha",
      mode: "all",
    });
    expect(includeButton.text()).toBe("Staged+Unstaged");

    wrapper.unmount();
  });

  it("renders a filename header using the tokenized header class", async () => {
    diffMocks.parsePatchFilesMock.mockReturnValueOnce([
      {
        files: [
          {
            name: "src/sticky.ts",
            hunks: [],
          },
        ],
      },
    ]);

    invokeMock.mockImplementation(async (command) => {
      if (command === "git_diff") return "diff --git a/src/sticky.ts b/src/sticky.ts";
      return "";
    });

    const wrapper = mount(DiffView, {
      props: {
        repoPath: "/repo",
        initialScope: "working",
      },
      attachTo: document.body,
      global: {
        mocks: {
          $t: (key: string) => key,
        },
      },
    });

    await flushPromises();
    await flushPromises();

    const header = wrapper.get(".diff-file-header");
    expect(header.text()).toBe("src/sticky.ts");
    expect(header.classes()).toContain("diff-file-header");
    expect(header.attributes("style")).toBeUndefined();

    wrapper.unmount();
  });

  it("yields after the first file render so broad diffs can paint early", async () => {
    vi.useFakeTimers();
    diffMocks.parsePatchFilesMock.mockReturnValueOnce([
      {
        files: [
          { name: "diff-perf/Cargo-0001.lock", hunks: [] },
          { name: "diff-perf/Cargo-0002.lock", hunks: [] },
          { name: "diff-perf/Cargo-0003.lock", hunks: [] },
        ],
      },
    ]);

    invokeMock.mockImplementation(async (command) => {
      if (command === "git_diff") return "diff --git a/perf b/perf";
      return "";
    });

    let wrapper: ReturnType<typeof mount<typeof DiffView>> | null = null;

    try {
      wrapper = mount(DiffView, {
        props: {
          repoPath: "/repo",
        },
        attachTo: document.body,
        global: {
          mocks: {
            $t: (key: string) => key,
          },
        },
      });

      await flushPromises();
      await flushPromises();

      expect(renderMock).toHaveBeenCalledTimes(1);
    } finally {
      wrapper?.unmount();
      vi.useRealTimers();
    }
  });

  it("waits for the first file post-render before scheduling the remaining broad diff", async () => {
    vi.useFakeTimers();
    diffMocks.parsePatchFilesMock.mockReturnValueOnce([
      {
        files: [
          {
            name: "diff-perf/Cargo-0001.lock",
            hunks: [],
            __deferPostRender: true,
            __postRenderDelayMs: 50,
          },
          { name: "diff-perf/Cargo-0002.lock", hunks: [] },
          { name: "diff-perf/Cargo-0003.lock", hunks: [] },
        ],
      },
    ]);

    invokeMock.mockImplementation(async (command) => {
      if (command === "git_diff") return "diff --git a/perf b/perf";
      return "";
    });

    let wrapper: ReturnType<typeof mount<typeof DiffView>> | null = null;

    try {
      wrapper = mount(DiffView, {
        props: {
          repoPath: "/repo",
          initialScope: "working",
        },
        attachTo: document.body,
        global: {
          mocks: {
            $t: (key: string) => key,
          },
        },
      });

      await flushPromises();
      await flushPromises();

      expect(renderMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(0);
      await flushPromises();
      expect(renderMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(50);
      await flushPromises();
      await vi.runOnlyPendingTimersAsync();
      await flushPromises();
      expect(renderMock).toHaveBeenCalledTimes(3);
    } finally {
      wrapper?.unmount();
      vi.useRealTimers();
    }
  });

  it("skips rendering files with oversized diff lines while keeping other files visible", async () => {
    diffMocks.parsePatchFilesMock.mockReturnValueOnce([
      {
        files: [
          {
            name: "src/normal.ts",
            hunks: [],
            additionLines: ["const ok = true;"],
            deletionLines: [],
          },
          {
            name: "artifacts/raw-capture.json",
            hunks: [],
            additionLines: ["x".repeat(300_000)],
            deletionLines: [],
          },
        ],
      },
    ]);

    invokeMock.mockImplementation(async (command) => {
      if (command === "git_diff") return "diff --git a/src/normal.ts b/src/normal.ts";
      return "";
    });

    const wrapper = mount(DiffView, {
      props: {
        repoPath: "/repo",
        initialScope: "working",
      },
      attachTo: document.body,
      global: {
        mocks: {
          $t: (key: string) => key,
        },
      },
    });

    await flushPromises();
    await flushPromises();

    expect(renderMock).toHaveBeenCalledTimes(1);
    expect(renderMock.mock.calls[0][0].fileDiff).toMatchObject({
      name: "src/normal.ts",
    });
    expect(wrapper.findAll(".diff-file-header").map((header) => header.text())).toEqual([
      "src/normal.ts",
      "artifacts/raw-capture.json",
    ]);
    expect(wrapper.get(".diff-file-skipped").text()).toBe(
      "Large diff omitted to keep the viewer responsive.",
    );

    wrapper.unmount();
  });

  it("restores the previous scroll position when switching diff scopes", async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === "git_diff") return "diff --git a/working.txt b/working.txt";
      if (command === "git_default_branch") return "main";
      if (command === "git_merge_base") return "base-sha";
      if (command === "git_diff_branch_range") return "diff --git a/branch.txt b/branch.txt";
      return "";
    });
    renderMock.mockImplementation(({ containerWrapper }: { containerWrapper?: HTMLElement }) => {
      containerWrapper?.parentElement?.scrollTo({ top: 0 });
    });

    const wrapper = mount(DiffView, {
      props: {
        repoPath: "/repo",
        initialScope: "working",
      },
      attachTo: document.body,
      global: {
        mocks: {
          $t: (key: string) => key,
        },
      },
    });

    const container = wrapper.get(".diff-container").element as HTMLElement;
    container.scrollTo = ({ top }: ScrollToOptions) => {
      container.scrollTop = top ?? 0;
    };

    await flushPromises();
    await flushPromises();

    const [workingButton, branchButton] = wrapper.findAll("button");

    container.scrollTop = 240;
    await branchButton.trigger("click");
    await flushPromises();
    await flushPromises();

    container.scrollTop = 520;
    await workingButton.trigger("click");
    await flushPromises();
    await flushPromises();

    expect(container.scrollTop).toBe(240);

    await branchButton.trigger("click");
    await flushPromises();
    await flushPromises();
    await flushPromises();

    expect(container.scrollTop).toBe(520);

    wrapper.unmount();
  });

  it("reapplies restored scroll position after async diff content renders", async () => {
    vi.useFakeTimers();
    diffMocks.parsePatchFilesMock.mockReturnValueOnce([
      {
        files: [
          {
            name: "async-working.txt",
            hunks: [],
            __deferPostRender: true,
          },
        ],
      },
    ]);

    invokeMock.mockImplementation(async (command) => {
      if (command === "git_diff") return "diff --git a/async-working.txt b/async-working.txt";
      return "";
    });

    let wrapper: ReturnType<typeof mount<typeof DiffView>> | null = null;

    try {
      wrapper = mount(DiffView, {
        props: {
          repoPath: "/repo",
          initialScope: "working",
          initialScrollPositions: { working: 640 },
        },
        attachTo: document.body,
        global: {
          mocks: {
            $t: (key: string) => key,
          },
        },
      });
      const container = wrapper.get(".diff-container").element as HTMLElement;
      const scrollTo = vi.fn(({ top }: ScrollToOptions) => {
        container.scrollTop = top ?? 0;
      });
      container.scrollTo = scrollTo;

      await flushPromises();
      await flushPromises();

      expect(scrollTo).toHaveBeenCalledTimes(1);
      expect(scrollTo).toHaveBeenLastCalledWith({ top: 640, behavior: "auto" });

      await vi.runOnlyPendingTimersAsync();
      await flushPromises();

      expect(scrollTo.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(scrollTo).toHaveBeenLastCalledWith({ top: 640, behavior: "auto" });
    } finally {
      wrapper?.unmount();
      vi.useRealTimers();
    }
  });

  it("does not overwrite saved scroll positions with render-time scroll events", async () => {
    diffMocks.parsePatchFilesMock.mockReturnValueOnce([
      {
        files: [
          {
            name: "render-scroll-reset.txt",
            hunks: [],
          },
        ],
      },
    ]);

    invokeMock.mockImplementation(async (command) => {
      if (command === "git_diff") return "diff --git a/render-scroll-reset.txt b/render-scroll-reset.txt";
      return "";
    });
    renderMock.mockImplementation(({ containerWrapper }: { containerWrapper?: HTMLElement }) => {
      const container = containerWrapper?.parentElement;
      if (container instanceof HTMLElement) {
        container.scrollTop = 0;
        container.dispatchEvent(new Event("scroll", { bubbles: true }));
      }
    });

    const wrapper = mount(DiffView, {
      props: {
        repoPath: "/repo",
        initialScope: "working",
        initialScrollPositions: { working: 640 },
      },
      attachTo: document.body,
      global: {
        mocks: {
          $t: (key: string) => key,
        },
      },
    });
    const container = wrapper.get(".diff-container").element as HTMLElement;
    const scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      container.scrollTop = top ?? 0;
    });
    container.scrollTo = scrollTo;

    await flushPromises();
    await flushPromises();

    expect(scrollTo).toHaveBeenLastCalledWith({ top: 640, behavior: "auto" });

    wrapper.unmount();
  });

  it("opens diff search with slash and focuses the input", async () => {
    diffMocks.parsePatchFilesMock.mockReturnValueOnce([
      {
        files: [
          {
            name: "src/example.ts",
            oldName: "src/example.ts",
            newName: "src/example.ts",
            hunks: [
              {
                hunkSpecs: "@@ -1,1 +1,1 @@",
                hunkContext: "function demo()",
                unifiedLineStart: 0,
                hunkContent: [
                  {
                    type: "change",
                    deletions: 1,
                    deletionLineIndex: 0,
                    additions: 1,
                    additionLineIndex: 0,
                  },
                ],
              },
            ],
            additionLines: ["const alpha = 2;"],
            deletionLines: ["const alpha = 1;"],
            __searchRows: [
              { lineIndex: "0,0", text: "const alpha = 1;" },
              { lineIndex: "1,0", text: "const alpha = 2;" },
            ],
          },
        ],
      },
    ]);

    invokeMock.mockImplementation(async (command) => {
      if (command === "git_diff") return "diff --git a/src/example.ts b/src/example.ts";
      return "";
    });

    const wrapper = mount(DiffView, {
      props: {
        repoPath: "/repo",
        initialScope: "working",
      },
      attachTo: document.body,
      global: {
        mocks: {
          $t: (key: string) => key,
        },
      },
    });

    await flushPromises();
    await flushPromises();

    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "/",
      bubbles: true,
    }));
    await flushPromises();

    const input = wrapper.get(".search-input");
    expect(document.activeElement).toBe(input.element);

    wrapper.unmount();
  });

  it("returns focus to the diff view after confirming search with Enter", async () => {
    diffMocks.parsePatchFilesMock.mockReturnValueOnce([
      {
        files: [
          {
            name: "src/example.ts",
            oldName: "src/example.ts",
            newName: "src/example.ts",
            hunks: [
              {
                hunkSpecs: "@@ -1,1 +1,1 @@",
                hunkContext: "function demo()",
                unifiedLineStart: 0,
                hunkContent: [
                  {
                    type: "change",
                    deletions: 1,
                    deletionLineIndex: 0,
                    additions: 1,
                    additionLineIndex: 0,
                  },
                ],
              },
            ],
            additionLines: ["const alpha = 2;"],
            deletionLines: ["const alpha = 1;"],
            __searchRows: [
              { lineIndex: "0,0", text: "const alpha = 1;" },
              { lineIndex: "1,0", text: "const alpha = 2;" },
            ],
          },
        ],
      },
    ]);

    invokeMock.mockImplementation(async (command) => {
      if (command === "git_diff") return "diff --git a/src/example.ts b/src/example.ts";
      return "";
    });

    const wrapper = mount(DiffView, {
      props: {
        repoPath: "/repo",
        initialScope: "working",
      },
      attachTo: document.body,
      global: {
        mocks: {
          $t: (key: string) => key,
        },
      },
    });

    await flushPromises();
    await flushPromises();

    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "/",
      bubbles: true,
    }));
    await flushPromises();

    const input = wrapper.get(".search-input");
    await input.setValue("alpha");
    await input.trigger("keydown", { key: "Enter" });
    await flushPromises();

    expect(document.activeElement).toBe(wrapper.get(".diff-view").element);

    wrapper.unmount();
  });

  it("marks the active diff search result in the rendered diff", async () => {
    diffMocks.parsePatchFilesMock.mockReturnValueOnce([
      {
        files: [
          {
            name: "src/example.ts",
            oldName: "src/example.ts",
            newName: "src/example.ts",
            hunks: [
              {
                hunkSpecs: "@@ -1,1 +1,1 @@",
                hunkContext: "function demo()",
                unifiedLineStart: 0,
                hunkContent: [
                  {
                    type: "change",
                    deletions: 1,
                    deletionLineIndex: 0,
                    additions: 1,
                    additionLineIndex: 0,
                  },
                ],
              },
            ],
            additionLines: ["const alpha = 2;"],
            deletionLines: ["const alpha = 1;"],
            __searchRows: [
              { lineIndex: "0,0", text: "const alpha = 1;" },
              { lineIndex: "1,0", text: "const alpha = 2;" },
            ],
          },
        ],
      },
    ]);

    invokeMock.mockImplementation(async (command) => {
      if (command === "git_diff") return "diff --git a/src/example.ts b/src/example.ts";
      return "";
    });

    const wrapper = mount(DiffView, {
      props: {
        repoPath: "/repo",
        initialScope: "working",
      },
      attachTo: document.body,
      global: {
        mocks: {
          $t: (key: string) => key,
        },
      },
    });

    await flushPromises();
    await flushPromises();

    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "/",
      bubbles: true,
    }));
    await flushPromises();

    const input = wrapper.get(".search-input");
    await input.setValue("alpha");
    await flushPromises();

    const container = wrapper.find(".diff-file diffs-container").element as HTMLElement;
    const shadowRoot = container.shadowRoot;

    expect(shadowRoot?.querySelector('[data-content] [data-line-index="0,0"]')?.classList.contains("diff-search-match")).toBe(true);
    expect(shadowRoot?.querySelector('[data-content] [data-line-index="0,0"]')?.classList.contains("diff-search-active")).toBe(true);
    expect(shadowRoot?.querySelector("[data-title]")?.classList.contains("diff-search-match")).toBe(false);

    wrapper.unmount();
  });
});
