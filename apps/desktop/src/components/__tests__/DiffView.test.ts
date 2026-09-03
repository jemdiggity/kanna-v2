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
  isPartial?: boolean;
  additionLines?: string[];
  deletionLines?: string[];
  hunks?: Array<{
    hunkContent?: Array<
      | {
        type: "context";
        lines: number;
        additionLineIndex: number;
      }
      | {
        type: "change";
        additions: number;
        deletions: number;
        additionLineIndex: number;
        deletionLineIndex: number;
      }
    >;
  }>;
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

  function rowsFromParsedFileDiff(fileDiff: MockFileDiff, expandUnchanged?: boolean): MockSearchRow[] {
    const rows: MockSearchRow[] = [];
    for (const hunk of fileDiff.hunks ?? []) {
      for (const content of hunk.hunkContent ?? []) {
        if (content.type === "context") {
          for (let offset = 0; offset < content.lines; offset += 1) {
            rows.push({
              lineIndex: `context-${rows.length}`,
              text: fileDiff.additionLines?.[content.additionLineIndex + offset] ?? "",
            });
          }
        } else {
          for (let offset = 0; offset < content.deletions; offset += 1) {
            rows.push({
              lineIndex: `deletion-${rows.length}`,
              text: fileDiff.deletionLines?.[content.deletionLineIndex + offset] ?? "",
            });
          }
          for (let offset = 0; offset < content.additions; offset += 1) {
            rows.push({
              lineIndex: `addition-${rows.length}`,
              text: fileDiff.additionLines?.[content.additionLineIndex + offset] ?? "",
            });
          }
        }
      }
    }

    if (expandUnchanged || rows.length <= 8) return rows;
    return rows.slice(3, -3);
  }

  return {
    ...actual,
    parsePatchFiles: (...args: Parameters<typeof actual.parsePatchFiles>) => diffMocks.parsePatchFilesMock(...args),
    FileDiff: class {
      private options?: { expandUnchanged?: boolean; onPostRender?: () => void };

      constructor(options?: { expandUnchanged?: boolean; onPostRender?: () => void }) {
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
          const rows = diffMeta.__searchRows ?? rowsFromParsedFileDiff(diffMeta, this.options?.expandUnchanged);

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

async function waitForTimerTurn() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await flushPromises();
}

type TestDiffScrollPositions = Partial<Record<"branch" | "working", number>>;

function setupAnchoredDiffGeometry(documentTops: number[]) {
  diffMocks.parsePatchFilesMock.mockReturnValue([
    {
      files: [
        {
          name: "anchored-context.txt",
          __searchRows: [{ lineIndex: "anchor", text: "changed anchor" }],
          hunks: [],
        },
      ],
    },
  ]);

  invokeMock.mockImplementation(async (command) => {
    if (command === "git_diff") return "diff --git a/anchored-context.txt b/anchored-context.txt";
    return "";
  });

  const makeRect = (top: number, height: number): DOMRect => ({
    x: 0,
    y: top,
    top,
    right: 800,
    bottom: top + height,
    left: 0,
    width: 800,
    height,
    toJSON: () => ({}),
  }) as DOMRect;
  const containerTop = 100;
  let renderCount = 0;
  let activeContainer!: HTMLElement;

  renderMock.mockImplementation(({ containerWrapper }: { containerWrapper?: HTMLElement }) => {
    const line = containerWrapper
      ?.querySelector("diffs-container")
      ?.shadowRoot
      ?.querySelector<HTMLElement>('[data-content] [data-line-index="anchor"]');
    if (!line) return;
    const documentTop = documentTops[renderCount] ?? documentTops.at(-1)!;
    renderCount += 1;
    line.setAttribute("data-line", "8");
    line.setAttribute("data-line-type", "change-addition");
    line.getBoundingClientRect = () => makeRect(
      containerTop + documentTop - activeContainer.scrollTop,
      20,
    );
  });

  function mountDiff(initialScrollPositions?: TestDiffScrollPositions) {
    const wrapper = mount(DiffView, {
      props: {
        repoPath: "/repo",
        initialScope: "working",
        initialScrollPositions,
      },
      attachTo: document.body,
      global: {
        mocks: {
          $t: (key: string) => key,
        },
      },
    });
    activeContainer = wrapper.get(".diff-container").element as HTMLElement;
    activeContainer.getBoundingClientRect = () => makeRect(containerTop, 400);
    activeContainer.scrollTo = ({ top }: ScrollToOptions) => {
      activeContainer.scrollTop = top ?? 0;
    };
    return wrapper;
  }

  return {
    mountDiff,
    getContainer: () => activeContainer,
  };
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

  it("can reload the working diff with all unchanged lines", async () => {
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

    expect(invokeMock).toHaveBeenCalledWith("git_diff", {
      repoPath: "/repo",
      mode: "all",
    });

    const contextButton = wrapper.get(".context-toggle");
    expect(contextButton.text()).toBe("Context");

    await contextButton.trigger("click");
    await flushPromises();
    await flushPromises();

    expect(invokeMock).toHaveBeenLastCalledWith("git_diff", {
      repoPath: "/repo",
      mode: "all",
      contextLines: 4294967295,
    });
    expect(contextButton.text()).toBe("All lines");

    wrapper.unmount();
  });

  it("toggles branch diffs to all unchanged lines with the keyboard shortcut and renders hidden context", async () => {
    const compactPatch = [
      "diff --git a/context.txt b/context.txt",
      "index 1111111..2222222 100644",
      "--- a/context.txt",
      "+++ b/context.txt",
      "@@ -5,7 +5,7 @@",
      " line 5",
      " line 6",
      " line 7",
      "-line 8",
      "+changed 8",
      " line 9",
      " line 10",
      " line 11",
      "",
    ].join("\n");
    const fullPatch = [
      "diff --git a/context.txt b/context.txt",
      "index 1111111..2222222 100644",
      "--- a/context.txt",
      "+++ b/context.txt",
      "@@ -1,15 +1,15 @@",
      " line 1",
      " line 2",
      " line 3",
      " line 4",
      " line 5",
      " line 6",
      " line 7",
      "-line 8",
      "+changed 8",
      " line 9",
      " line 10",
      " line 11",
      " line 12",
      " line 13",
      " line 14",
      " line 15",
      "",
    ].join("\n");

    invokeMock.mockImplementation(async (command, args) => {
      if (command === "git_branch_upstream") return null;
      if (command === "git_merge_base") return "merge-base-sha";
      if (command === "git_diff_branch_range") {
        return (args?.contextLines === 4294967295) ? fullPatch : compactPatch;
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

    const renderedText = () =>
      Array.from(wrapper.findAll(".diff-file diffs-container"))
        .map((container) => (container.element as HTMLElement).shadowRoot?.textContent ?? "")
        .join("\n");
    const renderedRows = () =>
      Array.from(wrapper.findAll(".diff-file diffs-container"))
        .flatMap((container) =>
          Array.from(
            (container.element as HTMLElement).shadowRoot?.querySelectorAll("[data-content] [data-line-index]") ?? [],
          ).map((row) => (row.textContent ?? "").trimEnd()),
        );

    expect(invokeMock).toHaveBeenCalledWith("git_diff_branch_range", {
      repoPath: "/repo",
      from: "merge-base-sha",
      mode: "none",
    });
    expect(renderedText()).toContain("changed 8");
    expect(renderedRows()).not.toContain("line 1");
    expect(renderedRows()).not.toContain("line 15");
    expect(renderMock.mock.calls.at(-1)?.[0].fileDiff).toEqual(
      expect.objectContaining({ name: "context.txt" }),
    );

    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "a",
      bubbles: true,
    }));
    await flushPromises();
    await flushPromises();
    await waitForTimerTurn();

    expect(invokeMock).toHaveBeenLastCalledWith("git_diff_branch_range", {
      repoPath: "/repo",
      from: "merge-base-sha",
      mode: "none",
      contextLines: 4294967295,
    });
    expect(renderMock.mock.calls.at(-1)?.[0].fileDiff).toEqual(
      expect.objectContaining({ name: "context.txt" }),
    );
    expect(renderedRows()).toContain("line 1");
    expect(renderedRows()).toContain("line 15");
    expect(renderedText()).toContain("changed 8");

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
    expect(includeButton.text()).toBe("Committed");

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

  it("refreshes an open branch diff when the view regains focus after history changes", async () => {
    let branchPatchName = "before-rebase.txt";
    invokeMock.mockImplementation(async (command) => {
      if (command === "git_branch_upstream") return null;
      if (command === "git_merge_base") return "base-sha";
      if (command === "git_diff_branch_range") {
        return `diff --git a/${branchPatchName} b/${branchPatchName}`;
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

    expect(renderMock.mock.calls.at(-1)?.[0]?.fileDiff).toMatchObject({
      name: "before-rebase.txt",
    });

    await waitForTimerTurn();
    branchPatchName = "after-rebase.txt";
    window.dispatchEvent(new Event("focus"));
    await waitForTimerTurn();

    expect(renderMock.mock.calls.at(-1)?.[0]?.fileDiff).toMatchObject({
      name: "after-rebase.txt",
    });

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
    const patch = [
      "diff --git a/src/normal.ts b/src/normal.ts",
      "index 7898192..6178079 100644",
      "--- a/src/normal.ts",
      "+++ b/src/normal.ts",
      "@@ -1 +1 @@",
      "-const ok = false;",
      "+const ok = true;",
      "diff --git a/artifacts/raw-capture.json b/artifacts/raw-capture.json",
      "index 7898192..6178079 100644",
      "--- a/artifacts/raw-capture.json",
      "+++ b/artifacts/raw-capture.json",
      "@@ -1 +1 @@",
      "-{}",
      `+${"x".repeat(300_000)}`,
      "",
    ].join("\n");

    invokeMock.mockImplementation(async (command) => {
      if (command === "git_diff") return patch;
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

  it("skips files with oversized raw patch lines when parsed metadata omits the full line", async () => {
    const patch = [
      "diff --git a/src/normal.ts b/src/normal.ts",
      "index 7898192..6178079 100644",
      "--- a/src/normal.ts",
      "+++ b/src/normal.ts",
      "@@ -1 +1 @@",
      "-const ok = false;",
      "+const ok = true;",
      "diff --git a/artifacts/raw-capture.json b/artifacts/raw-capture.json",
      "index 7898192..6178079 100644",
      "--- a/artifacts/raw-capture.json",
      "+++ b/artifacts/raw-capture.json",
      "@@ -1 +1 @@",
      "-{}",
      `+${"x".repeat(300_000)}`,
      "",
    ].join("\n");

    diffMocks.parsePatchFilesMock.mockReturnValueOnce([
      {
        files: [
          {
            name: "src/normal.ts",
            hunks: [],
            additionLines: ["const ok = true;"],
            deletionLines: ["const ok = false;"],
          },
          {
            name: "artifacts/raw-capture.json",
            hunks: [],
            additionLines: ["[large line omitted by parser]"],
            deletionLines: ["{}"],
          },
        ],
      },
    ]);

    invokeMock.mockImplementation(async (command) => {
      if (command === "git_diff") return patch;
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

  it("keeps the anchored code line fixed throughout all-lines rendering", async () => {
    vi.useFakeTimers();
    diffMocks.parsePatchFilesMock
      .mockReturnValueOnce([
        {
          files: [
            {
              name: "anchored-context.txt",
              __searchRows: [{ lineIndex: "anchor", text: "changed anchor" }],
              hunks: [],
            },
          ],
        },
      ])
      .mockReturnValueOnce([
        {
          files: [
            {
              name: "anchored-context.txt",
              __searchRows: [{ lineIndex: "anchor", text: "changed anchor" }],
              __deferPostRender: true,
              hunks: [],
            },
          ],
        },
      ]);

    invokeMock.mockImplementation(async (command) => {
      if (command === "git_diff") return "diff --git a/anchored-context.txt b/anchored-context.txt";
      return "";
    });

    const makeRect = (top: number, height: number): DOMRect => ({
      x: 0,
      y: top,
      top,
      right: 800,
      bottom: top + height,
      left: 0,
      width: 800,
      height,
      toJSON: () => ({}),
    }) as DOMRect;

    const containerTop = 100;
    const compactLineDocumentTop = 280;
    let allLinesDocumentTop = 700;
    let renderCount = 0;
    let container!: HTMLElement;

    renderMock.mockImplementation(({ containerWrapper }: { containerWrapper?: HTMLElement }) => {
      renderCount += 1;
      const line = containerWrapper
        ?.querySelector("diffs-container")
        ?.shadowRoot
        ?.querySelector<HTMLElement>('[data-content] [data-line-index="anchor"]');
      if (!line) return;
      line.setAttribute("data-line", "8");
      line.setAttribute("data-line-type", "change-addition");
      line.getBoundingClientRect = () => makeRect(
        containerTop
          + (renderCount === 1 ? compactLineDocumentTop : allLinesDocumentTop)
          - container.scrollTop,
        20,
      );
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

      container = wrapper.get(".diff-container").element as HTMLElement;
      container.getBoundingClientRect = () => makeRect(containerTop, 400);
      container.scrollTo = ({ top }: ScrollToOptions) => {
        container.scrollTop = top ?? 0;
      };

      await flushPromises();
      await flushPromises();

      container.scrollTop = 200;
      container.dispatchEvent(new Event("scroll", { bubbles: true }));
      await nextTick();

      await wrapper.get(".context-toggle").trigger("click");
      await flushPromises();
      await flushPromises();

      expect(container.scrollTop).toBe(620);

      allLinesDocumentTop = 900;
      await vi.runOnlyPendingTimersAsync();
      await flushPromises();

      const anchoredLine = wrapper
        .get(".diff-file")
        .element
        .querySelector("diffs-container")
        ?.shadowRoot
        ?.querySelector<HTMLElement>('[data-line="8"][data-line-type="change-addition"]');
      expect(anchoredLine).not.toBeNull();
      expect(anchoredLine!.getBoundingClientRect().top - container.getBoundingClientRect().top).toBe(80);
      expect(container.scrollTop).toBe(820);
    } finally {
      wrapper?.unmount();
      vi.useRealTimers();
    }
  });

  it("restores the compact scroll position after an immediate all-lines round trip", async () => {
    const harness = setupAnchoredDiffGeometry([280, 700, 280]);
    const wrapper = harness.mountDiff();
    await flushPromises();
    await flushPromises();

    const container = harness.getContainer();
    container.scrollTop = 200;
    container.dispatchEvent(new Event("scroll", { bubbles: true }));
    await nextTick();

    const contextButton = wrapper.get(".context-toggle");
    await contextButton.trigger("click");
    await flushPromises();
    await flushPromises();
    expect(container.scrollTop).toBe(620);

    await contextButton.trigger("click");
    await flushPromises();
    await flushPromises();

    expect(contextButton.text()).toBe("Context");
    expect(container.scrollTop).toBe(200);

    wrapper.unmount();
  });

  it("remounts with the compact scroll position after all-lines anchoring", async () => {
    const harness = setupAnchoredDiffGeometry([280, 700, 280]);
    const firstWrapper = harness.mountDiff();
    await flushPromises();
    await flushPromises();

    harness.getContainer().scrollTop = 200;
    harness.getContainer().dispatchEvent(new Event("scroll", { bubbles: true }));
    await nextTick();

    await firstWrapper.get(".context-toggle").trigger("click");
    await flushPromises();
    await flushPromises();
    expect(harness.getContainer().scrollTop).toBe(620);

    harness.getContainer().dispatchEvent(new Event("scroll", { bubbles: true }));
    await nextTick();

    const savedPositions = firstWrapper.emitted("scroll-state-change")?.at(-1)?.[0] as
      | TestDiffScrollPositions
      | undefined;
    expect(savedPositions).toBeDefined();
    firstWrapper.unmount();

    const secondWrapper = harness.mountDiff(savedPositions);
    await flushPromises();
    await flushPromises();

    expect(secondWrapper.get(".context-toggle").text()).toBe("Context");
    expect(harness.getContainer().scrollTop).toBe(200);

    secondWrapper.unmount();
  });

  it("keeps the current all-lines anchor across a same-mode reload", async () => {
    const harness = setupAnchoredDiffGeometry([280, 700, 900, 280]);
    const wrapper = harness.mountDiff();
    await flushPromises();
    await flushPromises();

    const container = harness.getContainer();
    container.scrollTop = 200;
    container.dispatchEvent(new Event("scroll", { bubbles: true }));
    await nextTick();

    const contextButton = wrapper.get(".context-toggle");
    await contextButton.trigger("click");
    await flushPromises();
    await flushPromises();
    expect(container.scrollTop).toBe(620);

    await (wrapper.vm as unknown as { refresh: () => Promise<void> }).refresh();
    await flushPromises();
    await flushPromises();

    expect(container.scrollTop).toBe(820);

    await contextButton.trigger("click");
    await flushPromises();
    await flushPromises();
    expect(container.scrollTop).toBe(200);

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

  it("keeps branch search open after Enter without reloading the branch diff", async () => {
    diffMocks.parsePatchFilesMock.mockReturnValue([
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
      if (command === "git_branch_upstream") return null;
      if (command === "git_merge_base") return "base-sha";
      if (command === "git_diff_branch_range") return "diff --git a/src/example.ts b/src/example.ts";
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

    const branchDiffRangeCallsBeforeEnter = invokeMock.mock.calls.filter(
      ([command]) => command === "git_diff_branch_range",
    );
    expect(branchDiffRangeCallsBeforeEnter).toHaveLength(1);

    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "/",
      bubbles: true,
    }));
    await flushPromises();

    const input = wrapper.get(".search-input");
    await input.setValue("alpha");
    await input.trigger("keydown", { key: "Enter" });
    await flushPromises();
    await waitForTimerTurn();

    expect((wrapper.get(".search-input").element as HTMLInputElement).value).toBe("alpha");
    expect(wrapper.get(".search-count").text()).toBe("2/2");
    expect(document.activeElement).toBe(wrapper.get(".diff-view").element);
    expect(invokeMock.mock.calls.filter(([command]) => command === "git_diff_branch_range")).toHaveLength(1);

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

  it("loads remote diffs without invoking local git commands", async () => {
    const remoteDiffLoader = vi.fn(async () => ({
      taskId: "owner-task",
      baseRef: "main",
      mergeBase: "base-sha",
      patch: "diff --git a/remote.ts b/remote.ts",
      truncated: false,
    }));
    const wrapper = mount(DiffView, {
      props: {
        repoPath: "",
        initialScope: "working",
        remoteDiffLoader,
      },
      global: { mocks: { $t: (key: string) => key } },
    });

    await flushPromises();
    await flushPromises();

    expect(remoteDiffLoader).toHaveBeenCalledWith({ scope: "working", mode: "all" });
    expect(invokeMock).not.toHaveBeenCalled();
    expect(wrapper.find(".diff-file").exists()).toBe(true);
    wrapper.unmount();
  });

  it("renders an explicit unavailable state when a remote diff cannot be read", async () => {
    const wrapper = mount(DiffView, {
      props: {
        repoPath: "",
        remoteDiffLoader: vi.fn(async () => {
          throw new Error("owner machine is offline");
        }),
      },
      global: { mocks: { $t: (key: string) => key } },
    });

    await flushPromises();
    await flushPromises();

    expect(wrapper.get('[data-testid="diff-unavailable"]').text()).toContain(
      "Task diff unavailable: owner machine is offline",
    );
    expect(wrapper.text()).not.toContain("No changes");
    wrapper.unmount();
  });
});
