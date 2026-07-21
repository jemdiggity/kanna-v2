import React from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskDiffContent } from "../lib/api/types";

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

let TaskDiffPreview: typeof import("./TaskDiffPreview").TaskDiffPreview;
let isTaskDiffErrorRetryable:
  typeof import("./TaskDiffPreview").isTaskDiffErrorRetryable;

beforeAll(async () => {
  const module = await import("./TaskDiffPreview");
  TaskDiffPreview = module.TaskDiffPreview;
  isTaskDiffErrorRetryable = module.isTaskDiffErrorRetryable;
});

beforeEach(() => {
  for (const slot of harness.effectSlots) slot?.cleanup?.();
  harness.effectSlots.length = 0;
  harness.hookIndex = 0;
  harness.memoSlots.length = 0;
  harness.pendingEffects.length = 0;
  harness.refs.length = 0;
  harness.states.length = 0;
});

function sampleDiff(overrides: Partial<TaskDiffContent> = {}): TaskDiffContent {
  return {
    taskId: "task-1",
    baseRef: "main",
    mergeBase: "abc123",
    patch: `diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old line\n+new line\n`,
    truncated: false,
    ...overrides
  };
}

function renderPreview(overrides: Partial<{
  readDiff: () => Promise<TaskDiffContent>;
  onClose: () => void;
}> = {}): ElementNode {
  harness.hookIndex = 0;
  return TaskDiffPreview({
    readDiff: overrides.readDiff ?? vi.fn().mockResolvedValue(sampleDiff()),
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

describe("TaskDiffPreview", () => {
  it("loads on mount and renders the diff document with the base ref", async () => {
    const request = deferred<TaskDiffContent>();
    const readDiff = vi.fn(() => request.promise);
    let tree = renderPreview({ readDiff });

    expect(findByType(tree, "ActivityIndicator")).not.toBeNull();
    expect(readDiff).not.toHaveBeenCalled();

    await runEffects();
    expect(readDiff).toHaveBeenCalledOnce();

    request.resolve(sampleDiff());
    await Promise.resolve();
    await Promise.resolve();
    tree = renderPreview({ readDiff });

    expect(textContent(findByTestId(tree, "mobile.task-diff.base"))).toBe(
      "Changes vs main"
    );
    const webView = findByType(tree, "WebView");
    const html = (webView?.props?.source as { html: string }).html;
    expect(html).toContain("src/app.ts");
    expect(html).toContain("+new line");
    expect(html).toContain("-old line");
  });

  it("shows a scope subtitle while loading and without a base ref", async () => {
    const readDiff = vi.fn().mockResolvedValue(sampleDiff({ baseRef: null }));
    let tree = renderPreview({ readDiff });

    expect(textContent(findByTestId(tree, "mobile.task-diff.base"))).toBe(
      "Branch changes"
    );

    await runEffects();
    tree = renderPreview({ readDiff });
    expect(textContent(findByTestId(tree, "mobile.task-diff.base"))).toBe(
      "Branch changes"
    );
  });

  it("renders the empty state document when the patch is empty", async () => {
    const readDiff = vi.fn().mockResolvedValue(sampleDiff({ patch: "" }));
    let tree = renderPreview({ readDiff });
    await runEffects();
    tree = renderPreview({ readDiff });

    const html = (findByType(tree, "WebView")?.props?.source as { html: string })
      .html;
    expect(html).toContain("No changes compared to main.");
  });

  it("surfaces the truncation notice for oversized diffs", async () => {
    const readDiff = vi
      .fn()
      .mockResolvedValue(sampleDiff({ truncated: true }));
    let tree = renderPreview({ readDiff });
    await runEffects();
    tree = renderPreview({ readDiff });

    const html = (findByType(tree, "WebView")?.props?.source as { html: string })
      .html;
    expect(html).toContain("Diff is too large to display fully");
  });

  it("retries retryable failures with a new read", async () => {
    const readDiff = vi
      .fn<() => Promise<TaskDiffContent>>()
      .mockRejectedValueOnce(new Error("LAN request failed (409)"))
      .mockResolvedValueOnce(sampleDiff());
    let tree = renderPreview({ readDiff });
    await runEffects();
    tree = renderPreview({ readDiff });

    expect(
      textContent(findByTestId(tree, "mobile.task-diff.error-message"))
    ).toContain("409");
    const retry = findPressableByText(tree, "Retry");
    expect(retry).not.toBeNull();
    (retry?.props?.onPress as () => void)();
    tree = renderPreview({ readDiff });
    expect(findByType(tree, "ActivityIndicator")).not.toBeNull();

    await runEffects();
    tree = renderPreview({ readDiff });
    expect(readDiff).toHaveBeenCalledTimes(2);
    expect(findByType(tree, "WebView")).not.toBeNull();
  });

  it.each([
    "LAN request failed (404) for /v1/tasks/task-1/diff",
    "Remote desktop request failed with status 404.",
    "task not found"
  ])("does not offer Retry for a nonretryable error: %s", async (message) => {
    const readDiff = vi.fn().mockRejectedValue(new Error(message));
    let tree = renderPreview({ readDiff });
    await runEffects();
    tree = renderPreview({ readDiff });

    expect(findPressableByText(tree, "Retry")).toBeNull();
    expect(textContent(tree)).toContain(message);
  });

  it("classifies workspace, relay, and unknown failures as retryable", () => {
    expect(isTaskDiffErrorRetryable(new Error("LAN request failed (409)"))).toBe(
      true
    );
    expect(
      isTaskDiffErrorRetryable(new Error("task workspace unavailable"))
    ).toBe(true);
    expect(isTaskDiffErrorRetryable(new Error("relay unavailable"))).toBe(true);
    expect(isTaskDiffErrorRetryable("unknown failure")).toBe(true);
  });

  it("allows only the local document WebView navigation with scripts disabled", async () => {
    const readDiff = vi.fn().mockResolvedValue(sampleDiff());
    let tree = renderPreview({ readDiff });
    await runEffects();
    tree = renderPreview({ readDiff });

    const webView = findByType(tree, "WebView");
    const shouldStart = webView?.props?.onShouldStartLoadWithRequest as (request: {
      url: string;
    }) => boolean;

    expect(webView?.props?.javaScriptEnabled).toBe(false);
    expect(shouldStart({ url: "about:blank" })).toBe(true);
    expect(shouldStart({ url: "https://example.com" })).toBe(false);
    expect(shouldStart({ url: "file:///tmp/secret" })).toBe(false);
  });

  it("refetches with the selected scope and mode", async () => {
    const readDiff = vi.fn().mockResolvedValue(sampleDiff());
    let tree = renderPreview({ readDiff });
    await runEffects();

    expect(readDiff).toHaveBeenNthCalledWith(1, { scope: "branch", mode: "all" });
    tree = renderPreview({ readDiff });
    expect(findByTestId(tree, "mobile.task-diff.mode.none")).not.toBeNull();
    expect(findByTestId(tree, "mobile.task-diff.mode.unstaged")).toBeNull();

    const workingScope = findByTestId(tree, "mobile.task-diff.scope.working");
    (workingScope?.props?.onPress as () => void)();
    tree = renderPreview({ readDiff });
    expect(findByType(tree, "ActivityIndicator")).not.toBeNull();
    await runEffects();
    expect(readDiff).toHaveBeenNthCalledWith(2, { scope: "working", mode: "all" });

    tree = renderPreview({ readDiff });
    expect(findByTestId(tree, "mobile.task-diff.mode.unstaged")).not.toBeNull();
    expect(findByTestId(tree, "mobile.task-diff.mode.none")).toBeNull();
    expect(textContent(findByTestId(tree, "mobile.task-diff.base"))).toBe(
      "Working tree changes"
    );

    const stagedMode = findByTestId(tree, "mobile.task-diff.mode.staged");
    (stagedMode?.props?.onPress as () => void)();
    renderPreview({ readDiff });
    await runEffects();
    expect(readDiff).toHaveBeenNthCalledWith(3, { scope: "working", mode: "staged" });
  });

  it("resets to the scope default mode when switching scopes", async () => {
    const readDiff = vi.fn().mockResolvedValue(sampleDiff());
    let tree = renderPreview({ readDiff });
    await runEffects();
    tree = renderPreview({ readDiff });

    const stagedMode = findByTestId(tree, "mobile.task-diff.mode.staged");
    (stagedMode?.props?.onPress as () => void)();
    tree = renderPreview({ readDiff });
    await runEffects();
    expect(readDiff).toHaveBeenNthCalledWith(2, { scope: "branch", mode: "staged" });

    const workingScope = findByTestId(tree, "mobile.task-diff.scope.working");
    (workingScope?.props?.onPress as () => void)();
    renderPreview({ readDiff });
    await runEffects();
    expect(readDiff).toHaveBeenNthCalledWith(3, { scope: "working", mode: "all" });
  });

  it("closes from both the control and the native modal request", () => {
    const onClose = vi.fn();
    const tree = renderPreview({ onClose });

    (findPressableByText(tree, "Close")?.props?.onPress as () => void)();
    (findByType(tree, "Modal")?.props?.onRequestClose as () => void)();

    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
