import React from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskFileContent } from "../lib/api/types";

interface EffectSlot {
  cleanup?: () => void;
  dependencies?: readonly unknown[];
}

interface PendingEffect {
  callback: () => void | (() => void);
  dependencies?: readonly unknown[];
  index: number;
}

interface MemoSlot {
  dependencies?: readonly unknown[];
  value: unknown;
}

const harness = vi.hoisted(() => ({
  effectSlots: [] as EffectSlot[],
  hookIndex: 0,
  memoSlots: [] as MemoSlot[],
  pendingEffects: [] as PendingEffect[],
  refs: [] as Array<{ current: unknown }>,
  states: [] as unknown[]
}));

const previewDocumentMocks = vi.hoisted(() => ({
  prepareMarkdown: vi.fn()
}));

function dependenciesChanged(
  previous: readonly unknown[] | undefined,
  next: readonly unknown[] | undefined
): boolean {
  if (!previous || !next || previous.length !== next.length) return true;
  return previous.some((value, index) => !Object.is(value, next[index]));
}

vi.mock("react", async (importActual) => {
  const actual = await importActual<typeof import("react")>();

  return {
    ...actual,
    useEffect: vi.fn(
      (
        callback: () => void | (() => void),
        dependencies?: readonly unknown[]
      ) => {
        const index = harness.hookIndex++;
        const slot = harness.effectSlots[index];
        if (!slot || dependenciesChanged(slot.dependencies, dependencies)) {
          harness.pendingEffects.push({ callback, dependencies, index });
        }
      }
    ),
    useMemo: vi.fn(
      (factory: () => unknown, dependencies?: readonly unknown[]) => {
        const index = harness.hookIndex++;
        const slot = harness.memoSlots[index];
        if (!slot || dependenciesChanged(slot.dependencies, dependencies)) {
          harness.memoSlots[index] = { dependencies, value: factory() };
        }
        return harness.memoSlots[index].value;
      }
    ),
    useRef: vi.fn((initialValue: unknown) => {
      const index = harness.hookIndex++;
      harness.refs[index] ??= { current: initialValue };
      return harness.refs[index];
    }),
    useState: vi.fn((initialValue: unknown) => {
      const index = harness.hookIndex++;
      if (!(index in harness.states)) {
        harness.states[index] =
          typeof initialValue === "function"
            ? (initialValue as () => unknown)()
            : initialValue;
      }

      return [
        harness.states[index],
        (nextValue: unknown) => {
          harness.states[index] =
            typeof nextValue === "function"
              ? (nextValue as (current: unknown) => unknown)(harness.states[index])
              : nextValue;
        }
      ];
    })
  };
});

vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Modal: "Modal",
  Pressable: "Pressable",
  SafeAreaView: "SafeAreaView",
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T) => styles
  },
  Text: "Text",
  View: "View"
}));

vi.mock("./buildTaskFilePreviewDocument", async (importActual) => {
  const actual = await importActual<
    typeof import("./buildTaskFilePreviewDocument")
  >();
  const prepareMarkdown = (
    actual as typeof actual & {
      prepareTaskFileMarkdown(content: string): unknown;
    }
  ).prepareTaskFileMarkdown;
  previewDocumentMocks.prepareMarkdown.mockImplementation((content: string) =>
    prepareMarkdown(content)
  );

  return {
    ...actual,
    prepareTaskFileMarkdown: previewDocumentMocks.prepareMarkdown
  };
});

vi.mock("react-native-webview", () => ({
  WebView: "WebView"
}));

interface ElementNode {
  type: unknown;
  props?: {
    children?: unknown;
    testID?: string;
    [key: string]: unknown;
  };
}

let TaskFilePreview: typeof import("./TaskFilePreview").TaskFilePreview;
let isTaskFilePreviewErrorRetryable:
  typeof import("./TaskFilePreview").isTaskFilePreviewErrorRetryable;

beforeAll(async () => {
  const module = await import("./TaskFilePreview");
  TaskFilePreview = module.TaskFilePreview;
  isTaskFilePreviewErrorRetryable = module.isTaskFilePreviewErrorRetryable;
});

beforeEach(() => {
  for (const slot of harness.effectSlots) slot?.cleanup?.();
  harness.effectSlots.length = 0;
  harness.hookIndex = 0;
  harness.memoSlots.length = 0;
  harness.pendingEffects.length = 0;
  harness.refs.length = 0;
  harness.states.length = 0;
  previewDocumentMocks.prepareMarkdown.mockClear();
});

function renderPreview(overrides: Partial<{
  path: string;
  initialLine: number;
  readFile: () => Promise<TaskFileContent>;
  onClose: () => void;
}> = {}): ElementNode {
  harness.hookIndex = 0;
  return TaskFilePreview({
    path: overrides.path ?? "docs/spec.md",
    initialLine: overrides.initialLine,
    readFile:
      overrides.readFile ??
      vi.fn().mockResolvedValue({ path: "docs/spec.md", content: "# Spec" }),
    onClose: overrides.onClose ?? vi.fn()
  }) as ElementNode;
}

async function runEffects(): Promise<void> {
  const pending = [...harness.pendingEffects];
  harness.pendingEffects.length = 0;
  for (const effect of pending) {
    harness.effectSlots[effect.index]?.cleanup?.();
    const cleanup = effect.callback();
    harness.effectSlots[effect.index] = {
      cleanup: typeof cleanup === "function" ? cleanup : undefined,
      dependencies: effect.dependencies
    };
  }
  await Promise.resolve();
  await Promise.resolve();
}

function childrenOf(node: ElementNode): unknown[] {
  return React.Children.toArray(node.props?.children);
}

function findNode(
  node: unknown,
  predicate: (candidate: ElementNode) => boolean
): ElementNode | null {
  if (!React.isValidElement(node)) return null;
  const candidate = node as ElementNode;
  if (predicate(candidate)) return candidate;
  for (const child of childrenOf(candidate)) {
    const match = findNode(child, predicate);
    if (match) return match;
  }
  return null;
}

function textContent(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (!React.isValidElement(node)) return "";
  return textContent((node as ElementNode).props?.children);
}

function findByType(node: ElementNode, type: string): ElementNode | null {
  return findNode(node, (candidate) => candidate.type === type);
}

function findByTestId(node: ElementNode, testID: string): ElementNode | null {
  return findNode(node, (candidate) => candidate.props?.testID === testID);
}

function findPressableByText(node: ElementNode, text: string): ElementNode | null {
  return findNode(
    node,
    (candidate) => candidate.type === "Pressable" && textContent(candidate) === text
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("TaskFilePreview", () => {
  it("loads on mount and replaces the requested path with the normalized path", async () => {
    const request = deferred<TaskFileContent>();
    const readFile = vi.fn(() => request.promise);
    let tree = renderPreview({ path: "/worktree/docs/./spec.md", readFile });

    expect(findByType(tree, "ActivityIndicator")).not.toBeNull();
    expect(readFile).not.toHaveBeenCalled();

    await runEffects();
    expect(readFile).toHaveBeenCalledOnce();

    request.resolve({ path: "docs/spec.md", content: "# Spec" });
    await Promise.resolve();
    await Promise.resolve();
    tree = renderPreview({ path: "/worktree/docs/./spec.md", readFile });

    expect(textContent(findByTestId(tree, "mobile.task-file-preview.path"))).toBe(
      "docs/spec.md"
    );
    expect(findByType(tree, "WebView")).not.toBeNull();
  });

  it("starts Markdown rendered and toggles to raw source", async () => {
    const readFile = vi.fn().mockResolvedValue({
      path: "DOCS/SPEC.MD",
      content: "# Spec"
    });
    let tree = renderPreview({ path: "DOCS/SPEC.MD", readFile });
    await runEffects();
    tree = renderPreview({ path: "DOCS/SPEC.MD", readFile });

    let webView = findByType(tree, "WebView");
    expect((webView?.props?.source as { html: string }).html).toContain(
      "<h1>Spec</h1>"
    );

    const rawToggle = findPressableByText(tree, "Raw");
    expect(rawToggle).not.toBeNull();
    (rawToggle?.props?.onPress as () => void)();
    tree = renderPreview({ path: "DOCS/SPEC.MD", readFile });
    webView = findByType(tree, "WebView");

    expect((webView?.props?.source as { html: string }).html).toContain(
      '<pre class="raw"># Spec</pre>'
    );
    expect(findPressableByText(tree, "Rendered")).not.toBeNull();
  });

  it("shows large Markdown as raw source without offering rendered mode", async () => {
    const content = "x\n\n".repeat(50_000);
    const readFile = vi.fn().mockResolvedValue({
      path: "docs/large-spec.md",
      content
    });
    let tree = renderPreview({ path: "docs/large-spec.md", readFile });
    await runEffects();
    tree = renderPreview({ path: "docs/large-spec.md", readFile });

    const html = (findByType(tree, "WebView")?.props?.source as { html: string })
      .html;
    expect(html).toContain('<pre class="raw">');
    expect(html).not.toContain('<main class="markdown">');
    expect(textContent(tree)).toContain(
      "Rendered preview unavailable for large Markdown"
    );
    expect(findPressableByText(tree, "Rendered")).toBeNull();
    expect(findPressableByText(tree, "Raw")).toBeNull();
  });

  it("prepares Markdown once and reuses it across stable rerenders and toggles", async () => {
    const readFile = vi.fn().mockResolvedValue({
      path: "docs/spec.md",
      content: "# Stable"
    });
    let tree = renderPreview({ path: "docs/spec.md", readFile });
    await runEffects();
    tree = renderPreview({ path: "docs/spec.md", readFile });

    expect(previewDocumentMocks.prepareMarkdown).toHaveBeenCalledOnce();
    tree = renderPreview({ path: "docs/spec.md", readFile });
    expect(previewDocumentMocks.prepareMarkdown).toHaveBeenCalledOnce();

    (findPressableByText(tree, "Raw")?.props?.onPress as () => void)();
    renderPreview({ path: "docs/spec.md", readFile });
    expect(previewDocumentMocks.prepareMarkdown).toHaveBeenCalledOnce();
  });

  it("renders non-Markdown files as raw source without a mode toggle", async () => {
    const readFile = vi.fn().mockResolvedValue({
      path: "src/file.ts",
      content: "const value = 1;"
    });
    let tree = renderPreview({ path: "src/file.ts", readFile });
    await runEffects();
    tree = renderPreview({ path: "src/file.ts", readFile });

    const webView = findByType(tree, "WebView");
    expect((webView?.props?.source as { html: string }).html).toContain(
      '<pre class="raw">const value = 1;</pre>'
    );
    expect(findPressableByText(tree, "Rendered")).toBeNull();
    expect(findPressableByText(tree, "Raw")).toBeNull();
  });

  it("starts a linked Markdown line in raw mode and targets that line", async () => {
    const readFile = vi.fn().mockResolvedValue({
      path: "docs/spec.md",
      content: "first\nsecond"
    });
    let tree = renderPreview({ path: "docs/spec.md", initialLine: 2, readFile });
    await runEffects();
    tree = renderPreview({ path: "docs/spec.md", initialLine: 2, readFile });

    const webView = findByType(tree, "WebView");
    const html = (webView?.props?.source as { html: string }).html;
    expect(html).toContain('data-line="2"');
    expect(html).toContain("scrollIntoView");
    expect(findPressableByText(tree, "Rendered")).not.toBeNull();
  });

  it("retries retryable failures with a new read", async () => {
    const readFile = vi
      .fn<() => Promise<TaskFileContent>>()
      .mockRejectedValueOnce(new Error("LAN request failed (404)"))
      .mockResolvedValueOnce({ path: "docs/spec.md", content: "# Recovered" });
    let tree = renderPreview({ readFile });
    await runEffects();
    tree = renderPreview({ readFile });

    const retry = findPressableByText(tree, "Retry");
    expect(retry).not.toBeNull();
    (retry?.props?.onPress as () => void)();
    tree = renderPreview({ readFile });
    expect(findByType(tree, "ActivityIndicator")).not.toBeNull();

    await runEffects();
    tree = renderPreview({ readFile });
    expect(readFile).toHaveBeenCalledTimes(2);
    expect((findByType(tree, "WebView")?.props?.source as { html: string }).html).toContain(
      "<h1>Recovered</h1>"
    );
  });

  it.each([
    "LAN request failed (400) for /v1/tasks/task-1/files/content",
    "Remote desktop request failed with status 413.",
    "LAN request failed (415) for /v1/tasks/task-1/files/content",
    "file path must stay within the task workspace",
    "file exceeds the 1 MiB limit",
    "file is not valid UTF-8 text"
  ])("does not offer Retry for a nonretryable error: %s", async (message) => {
    const readFile = vi.fn().mockRejectedValue(new Error(message));
    let tree = renderPreview({ readFile });
    await runEffects();
    tree = renderPreview({ readFile });

    expect(findPressableByText(tree, "Retry")).toBeNull();
    expect(textContent(tree)).toContain(message);
  });

  it("classifies missing, unavailable, transport, and unknown failures as retryable", () => {
    expect(isTaskFilePreviewErrorRetryable(new Error("LAN request failed (404)"))).toBe(
      true
    );
    expect(
      isTaskFilePreviewErrorRetryable(
        new Error("Remote desktop request failed with status 409.")
      )
    ).toBe(true);
    expect(isTaskFilePreviewErrorRetryable(new Error("relay unavailable"))).toBe(true);
    expect(isTaskFilePreviewErrorRetryable("unknown failure")).toBe(true);
  });

  it("ignores a stale completion after the requested path changes", async () => {
    const oldRequest = deferred<TaskFileContent>();
    const newRequest = deferred<TaskFileContent>();
    const oldRead = vi.fn(() => oldRequest.promise);
    const newRead = vi.fn(() => newRequest.promise);

    renderPreview({ path: "old.md", readFile: oldRead });
    await runEffects();
    let tree = renderPreview({ path: "new.md", readFile: newRead });
    await runEffects();

    oldRequest.resolve({ path: "old.md", content: "# Old" });
    await Promise.resolve();
    await Promise.resolve();
    tree = renderPreview({ path: "new.md", readFile: newRead });
    expect(textContent(tree)).not.toContain("old.md");
    expect(findByType(tree, "ActivityIndicator")).not.toBeNull();

    newRequest.resolve({ path: "new.md", content: "# New" });
    await Promise.resolve();
    await Promise.resolve();
    tree = renderPreview({ path: "new.md", readFile: newRead });
    expect(textContent(findByTestId(tree, "mobile.task-file-preview.path"))).toBe("new.md");
    expect((findByType(tree, "WebView")?.props?.source as { html: string }).html).toContain(
      "<h1>New</h1>"
    );
  });

  it("does not reload when only the inline read callback identity changes", async () => {
    const firstRead = vi.fn().mockResolvedValue({ path: "docs/spec.md", content: "# One" });
    const secondRead = vi.fn().mockResolvedValue({ path: "docs/spec.md", content: "# Two" });

    renderPreview({ readFile: firstRead });
    await runEffects();
    renderPreview({ readFile: secondRead });
    await runEffects();

    expect(firstRead).toHaveBeenCalledOnce();
    expect(secondRead).not.toHaveBeenCalled();
  });

  it("allows only the local document WebView navigation", async () => {
    const readFile = vi.fn().mockResolvedValue({
      path: "docs/spec.md",
      content: [
        "[blank](about:blank)",
        "[web](https://example.com)",
        "https://linkified.example"
      ].join("\n\n")
    });
    let tree = renderPreview({ readFile });
    await runEffects();
    tree = renderPreview({ readFile });
    const webView = findByType(tree, "WebView");
    const html = (webView?.props?.source as { html: string }).html;
    const shouldStart = webView?.props?.onShouldStartLoadWithRequest as (request: {
      url: string;
    }) => boolean;

    expect(html).toContain("<a>blank</a>");
    expect(html).toContain("<a>web</a>");
    expect(html).toContain("https://linkified.example");
    expect(html).not.toContain("<a>https://linkified.example</a>");
    expect(html).not.toMatch(/<a[^>]*\bhref=/i);
    expect(shouldStart({ url: "about:blank" })).toBe(true);
    expect(shouldStart({ url: "https://example.com" })).toBe(false);
    expect(shouldStart({ url: "file:///tmp/secret" })).toBe(false);
    expect(shouldStart({ url: "javascript:alert(1)" })).toBe(false);
  });

  it("closes from both the control and the native modal request", () => {
    const onClose = vi.fn();
    const tree = renderPreview({ onClose });

    (findPressableByText(tree, "Close")?.props?.onPress as () => void)();
    (findByType(tree, "Modal")?.props?.onRequestClose as () => void)();

    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
