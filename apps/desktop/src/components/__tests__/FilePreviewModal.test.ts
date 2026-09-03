// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import FilePreviewModal from "../FilePreviewModal.vue";
import { clearContextShortcuts, resetContext } from "../../composables/useShortcutContext";

const invokeMock = vi.fn<
  (command: string, args?: Record<string, unknown>) => Promise<unknown>
>();
const loadLanguageMock = vi.fn(async () => {});
const getLoadedLanguagesMock = vi.fn(() => ["text", "typescript", "python"]);
const codeToHtmlMock = vi.fn((code: string) => `<pre><code>${code}</code></pre>`);

vi.mock("../../invoke", () => ({
  invoke: (...args: [string, Record<string, unknown> | undefined]) => invokeMock(...args),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("shiki", () => ({
  createHighlighter: vi.fn(async () => ({
    loadLanguage: (...args: [string]) => loadLanguageMock(...args),
    getLoadedLanguages: (..._args: never[]) => getLoadedLanguagesMock(),
    codeToHtml: (...args: [string, Record<string, unknown>]) => codeToHtmlMock(...args),
  })),
}));

async function flushPromises() {
  await vi.dynamicImportSettled();
  await Promise.resolve();
  await nextTick();
}

describe("FilePreviewModal", () => {
  afterEach(() => {
    invokeMock.mockReset();
    loadLanguageMock.mockReset();
    getLoadedLanguagesMock.mockReset().mockReturnValue(["text", "typescript", "python"]);
    codeToHtmlMock.mockReset();
    clearContextShortcuts("file");
    resetContext();
    document.body.innerHTML = "";
  });

  it("renders Markdown by default when no mode is provided", async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === "read_text_file") {
        return "# Preview heading\n";
      }
      if (command === "run_script") {
        return "";
      }
      throw new Error(`unexpected invoke: ${command}`);
    });

    const wrapper = mount(FilePreviewModal, {
      props: {
        filePath: "README.md",
        worktreePath: "/repo",
      },
      attachTo: document.body,
      global: {
        mocks: {
          $t: (key: string) => key,
        },
      },
    });

    try {
      await vi.waitFor(() => {
        expect(wrapper.find(".markdown-rendered h1").exists()).toBe(true);
      });

      expect(wrapper.get(".preview-content").classes()).toContain("markdown-rendered");
      expect(wrapper.get(".mode-badge").text()).toBe("filePreview.rendered");
    } finally {
      wrapper.unmount();
    }
  });

  it("keeps non-Markdown files raw when rendered mode is requested", async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === "read_text_file") {
        return "const answer = 42;\n";
      }
      if (command === "run_script") {
        return "";
      }
      throw new Error(`unexpected invoke: ${command}`);
    });
    codeToHtmlMock.mockImplementation(
      (code: string) => `<pre><code>${code}</code></pre>`,
    );

    const wrapper = mount(FilePreviewModal, {
      props: {
        filePath: "example.ts",
        worktreePath: "/repo",
        initialMarkdownMode: "rendered",
      },
      attachTo: document.body,
      global: {
        mocks: {
          $t: (key: string) => key,
        },
      },
    });

    try {
      await vi.waitFor(() => {
        expect(wrapper.get(".preview-content").text()).toContain("const answer = 42;");
      });

      expect(wrapper.get(".preview-content").classes()).not.toContain("markdown-rendered");
      expect(wrapper.find(".mode-badge").exists()).toBe(false);
      expect(codeToHtmlMock).toHaveBeenCalled();
    } finally {
      wrapper.unmount();
    }
  });

  it("keeps Markdown raw when raw mode is explicitly requested", async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === "read_text_file") {
        return "# Raw heading\n";
      }
      if (command === "run_script") {
        return "";
      }
      throw new Error(`unexpected invoke: ${command}`);
    });
    codeToHtmlMock.mockImplementation(
      (code: string) => `<pre><code>${code}</code></pre>`,
    );

    const wrapper = mount(FilePreviewModal, {
      props: {
        filePath: "README.md",
        worktreePath: "/repo",
        initialMarkdownMode: "raw",
      },
      attachTo: document.body,
      global: {
        mocks: {
          $t: (key: string) => key,
        },
      },
    });

    try {
      await vi.waitFor(() => {
        expect(wrapper.get(".preview-content").text()).toContain("# Raw heading");
      });

      expect(wrapper.get(".preview-content").classes()).not.toContain("markdown-rendered");
      expect(wrapper.get(".mode-badge").text()).toBe("filePreview.raw");
    } finally {
      wrapper.unmount();
    }
  });

  it("uses the effective light code theme for Shiki rendering", async () => {
    const { resetThemeRuntimeForTests, setSystemPrefersDark, setThemePreferences } = await import("../../theme/runtime");
    resetThemeRuntimeForTests();
    setSystemPrefersDark(false);
    setThemePreferences({ appTheme: "light", codeTheme: "match" });
    invokeMock.mockImplementation(async (command) => {
      if (command === "read_text_file") {
        return "const answer = 42;\n";
      }
      if (command === "run_script") {
        return "";
      }
      throw new Error(`unexpected invoke: ${command}`);
    });

    const wrapper = mount(FilePreviewModal, {
      props: {
        filePath: "example.ts",
        worktreePath: "/repo",
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

    expect(codeToHtmlMock).toHaveBeenCalledWith(
      "const answer = 42;\n",
      expect.objectContaining({ theme: "github-light" }),
    );

    wrapper.unmount();
    resetThemeRuntimeForTests();
  });

  it("returns focus to the modal after confirming search with Enter", async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === "read_text_file") {
        return "alpha beta alpha";
      }
      if (command === "run_script") {
        return "";
      }
      throw new Error(`unexpected invoke: ${command}`);
    });

    const wrapper = mount(FilePreviewModal, {
      props: {
        filePath: "example.ts",
        worktreePath: "/repo",
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
    await flushPromises();

    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "/",
      bubbles: true,
    }));
    await flushPromises();

    const input = wrapper.get(".search-input");
    expect(document.activeElement).toBe(input.element);

    await input.setValue("alpha");
    await input.trigger("keydown", { key: "Enter" });
    await flushPromises();

    expect(document.activeElement).toBe(wrapper.get(".preview-modal").element);

    wrapper.unmount();
  });

  it("uses python highlighting for Bazel files", async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === "read_text_file") {
        return 'cc_library(name = "demo")\n';
      }
      if (command === "run_script") {
        return "";
      }
      throw new Error(`unexpected invoke: ${command}`);
    });

    const wrapper = mount(FilePreviewModal, {
      props: {
        filePath: "BUILD.bazel",
        worktreePath: "/repo",
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

    expect(loadLanguageMock).toHaveBeenCalledWith("python");
    expect(codeToHtmlMock).toHaveBeenCalledWith(
      'cc_library(name = "demo")\n',
      expect.objectContaining({ lang: "python" })
    );

    wrapper.unmount();
  });

  it("renders remote content without reading the local filesystem", async () => {
    invokeMock.mockImplementation(async (command) => {
      throw new Error(`unexpected invoke: ${command}`);
    });
    codeToHtmlMock.mockImplementation(
      (code: string) => `<pre><code>${code}</code></pre>`,
    );

    const wrapper = mount(FilePreviewModal, {
      props: {
        filePath: "src/app.ts",
        // The owning desktop's worktree path is meaningless on this machine;
        // the remote snapshot must be rendered without touching it.
        worktreePath: "/repo",
        remoteContent: "const fromRemoteDesktop = 42;\n",
      },
      attachTo: document.body,
      global: {
        mocks: {
          $t: (key: string) => key,
        },
      },
    });

    try {
      await vi.waitFor(() => {
        expect(wrapper.get(".preview-content").text()).toContain(
          "const fromRemoteDesktop = 42;",
        );
      });

      expect(invokeMock).not.toHaveBeenCalled();
      // Open-in-IDE would shell out against a path that does not exist here.
      expect(wrapper.find(".btn-open").exists()).toBe(false);
    } finally {
      wrapper.unmount();
    }
  });

  it("reloads the preview when newer remote content arrives", async () => {
    invokeMock.mockImplementation(async (command) => {
      throw new Error(`unexpected invoke: ${command}`);
    });
    codeToHtmlMock.mockImplementation(
      (code: string) => `<pre><code>${code}</code></pre>`,
    );

    const wrapper = mount(FilePreviewModal, {
      props: {
        filePath: "src/app.ts",
        worktreePath: "/repo",
        remoteContent: "first remote body\n",
      },
      attachTo: document.body,
      global: {
        mocks: {
          $t: (key: string) => key,
        },
      },
    });

    try {
      await vi.waitFor(() => {
        expect(wrapper.get(".preview-content").text()).toContain("first remote body");
      });

      await wrapper.setProps({ remoteContent: "second remote body\n" });

      await vi.waitFor(() => {
        expect(wrapper.get(".preview-content").text()).toContain("second remote body");
      });
      expect(invokeMock).not.toHaveBeenCalled();
    } finally {
      wrapper.unmount();
    }
  });

  it("keeps the Open in IDE action for local previews", async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === "read_text_file") {
        return "const answer = 42;\n";
      }
      throw new Error(`unexpected invoke: ${command}`);
    });
    codeToHtmlMock.mockImplementation(
      (code: string) => `<pre><code>${code}</code></pre>`,
    );

    const wrapper = mount(FilePreviewModal, {
      props: {
        filePath: "src/app.ts",
        worktreePath: "/repo",
      },
      attachTo: document.body,
      global: {
        mocks: {
          $t: (key: string) => key,
        },
      },
    });

    try {
      await vi.waitFor(() => {
        expect(wrapper.get(".preview-content").text()).toContain("const answer = 42;");
      });

      expect(wrapper.find(".btn-open").exists()).toBe(true);
      expect(invokeMock).toHaveBeenCalledWith("read_text_file", { path: "/repo/src/app.ts" });
    } finally {
      wrapper.unmount();
    }
  });

  it("dismiss closes search before closing the modal", async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === "read_text_file") {
        return "alpha beta alpha";
      }
      if (command === "run_script") {
        return "";
      }
      throw new Error(`unexpected invoke: ${command}`);
    });

    const wrapper = mount(FilePreviewModal, {
      props: {
        filePath: "example.ts",
        worktreePath: "/repo",
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
    await flushPromises();

    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "/",
      bubbles: true,
    }));
    await flushPromises();

    expect(wrapper.find(".search-input").exists()).toBe(true);

    const firstDismissResult = (wrapper.vm as { dismiss: () => boolean }).dismiss();
    await flushPromises();

    expect(firstDismissResult).toBe(false);
    expect(wrapper.emitted("close")).toBeUndefined();
    expect(wrapper.find(".search-input").exists()).toBe(false);

    const secondDismissResult = (wrapper.vm as { dismiss: () => boolean }).dismiss();
    await flushPromises();

    expect(secondDismissResult).toBe(true);
    expect(wrapper.emitted("close")).toBeUndefined();

    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "q",
      bubbles: true,
    }));
    await flushPromises();

    expect(wrapper.emitted("close")).toHaveLength(1);

    wrapper.unmount();
  });

  it("loads a remote task file without reading the local worktree", async () => {
    const remoteContentLoader = vi.fn(async () => "export const owner = 'machine-b';");
    const wrapper = mount(FilePreviewModal, {
      props: {
        filePath: "src/owner.ts",
        worktreePath: "",
        remoteContentLoader,
      },
      global: { mocks: { $t: (key: string) => key } },
    });

    try {
      await vi.waitFor(() => {
        expect(wrapper.get(".preview-content").text()).toContain("machine-b");
      });
      expect(remoteContentLoader).toHaveBeenCalledWith("src/owner.ts");
      expect(invokeMock).not.toHaveBeenCalledWith("read_text_file", expect.anything());
      expect(wrapper.find(".btn-open").exists()).toBe(false);
    } finally {
      wrapper.unmount();
    }
  });

  it("renders an explicit unavailable state when a remote task file read fails", async () => {
    const wrapper = mount(FilePreviewModal, {
      props: {
        filePath: "src/missing.ts",
        worktreePath: "",
        remoteContentLoader: vi.fn(async () => {
          throw new Error("task workspace unavailable");
        }),
      },
      global: { mocks: { $t: (key: string) => key } },
    });

    try {
      await vi.waitFor(() => {
        expect(wrapper.get('[data-testid="file-preview-unavailable"]').text()).toContain(
          "Task file unavailable: task workspace unavailable",
        );
      });
    } finally {
      wrapper.unmount();
    }
  });
});
