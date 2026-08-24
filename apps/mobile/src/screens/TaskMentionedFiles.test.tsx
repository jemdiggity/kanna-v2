import React from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  TaskFileMentionInput,
  TaskFileMentionResolution
} from "../lib/api/types";
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import type { TerminalFileMentionHistory } from "./terminalFileMentions";

interface EffectSlot {
  cleanup?: () => void;
  dependencies?: readonly unknown[];
}

interface PendingEffect {
  callback: () => void | (() => void);
  dependencies?: readonly unknown[];
  index: number;
}

const harness = vi.hoisted(() => ({
  effectSlots: [] as EffectSlot[],
  hookIndex: 0,
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
    useMemo: vi.fn((factory: () => unknown) => {
      harness.hookIndex += 1;
      return factory();
    }),
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
              ? (nextValue as (current: unknown) => unknown)(
                  harness.states[index]
                )
              : nextValue;
        }
      ];
    })
  };
});

vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  FlatList: "FlatList",
  Modal: "Modal",
  Pressable: "Pressable",
  SafeAreaView: "SafeAreaView",
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T) => styles
  },
  Text: "Text",
  View: "View"
}));

interface ElementNode {
  type: unknown;
  props?: {
    children?: unknown;
    testID?: string;
    [key: string]: unknown;
  };
}

let TaskMentionedFiles:
  typeof import("./TaskMentionedFiles").TaskMentionedFiles;

beforeAll(async () => {
  ({ TaskMentionedFiles } = await import("./TaskMentionedFiles"));
});

beforeEach(() => {
  for (const slot of harness.effectSlots) slot?.cleanup?.();
  harness.effectSlots.length = 0;
  harness.hookIndex = 0;
  harness.pendingEffects.length = 0;
  harness.refs.length = 0;
  harness.states.length = 0;
});

const history: TerminalFileMentionHistory = {
  mentions: [
    { raw: "Newest.ts:9", path: "Newest.ts", line: 9 },
    { raw: "Shared.ts", path: "Shared.ts" },
    { raw: "Missing.ts", path: "Missing.ts" }
  ],
  overflow: false
};

const resolution: TaskFileMentionResolution = {
  mentions: [
    {
      path: "Newest.ts",
      line: 9,
      matches: [{ path: "src/Newest.ts" }],
      truncated: false
    },
    {
      path: "Shared.ts",
      matches: [{ path: "b/Shared.ts" }, { path: "a/Shared.ts" }],
      truncated: false
    },
    {
      path: "Missing.ts",
      matches: [],
      truncated: false,
      unavailableReason: "file not found"
    }
  ]
};

interface RenderOptions {
  history?: TerminalFileMentionHistory;
  autoSelectUnique?: boolean;
  resolveMentions?: (
    mentions: readonly TaskFileMentionInput[]
  ) => Promise<TaskFileMentionResolution>;
  onSelect?: (selection: { path: string; line?: number }) => void;
  onClose?: () => void;
}

function renderMentionedFiles(options: RenderOptions = {}): ElementNode {
  harness.hookIndex = 0;
  return TaskMentionedFiles({
    history: options.history ?? history,
    autoSelectUnique: options.autoSelectUnique,
    resolveMentions:
      options.resolveMentions ?? vi.fn().mockResolvedValue(resolution),
    onSelect: options.onSelect ?? vi.fn(),
    onClose: options.onClose ?? vi.fn()
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

function findByType(node: ElementNode, type: string): ElementNode | null {
  return findNode(node, (candidate) => candidate.type === type);
}

function findByTestId(node: ElementNode, testID: string): ElementNode | null {
  return findNode(node, (candidate) => candidate.props?.testID === testID);
}

function textContent(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (!React.isValidElement(node)) return "";
  return textContent((node as ElementNode).props?.children);
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

describe("TaskMentionedFiles", () => {
  it("renders canonical choices in MRU order and selects with the mention line", async () => {
    const resolveMentions = vi.fn().mockResolvedValue(resolution);
    const onSelect = vi.fn();
    const options = { resolveMentions, onSelect };
    renderMentionedFiles(options);
    await runEffects();
    const tree = renderMentionedFiles(options);

    expect(resolveMentions).toHaveBeenCalledWith([
      { path: "Newest.ts", line: 9 },
      { path: "Shared.ts" },
      { path: "Missing.ts" }
    ]);
    const list = findByType(tree, "FlatList");
    const rows = list?.props?.data as Array<{ path: string; line?: number }>;
    expect(rows.map((row) => row.path)).toEqual([
      "src/Newest.ts",
      "a/Shared.ts",
      "b/Shared.ts",
      "Missing.ts"
    ]);
    const firstRow = (
      list?.props?.renderItem as (input: { item: typeof rows[number] }) => ElementNode
    )({ item: rows[0]! });
    (firstRow.props?.onPress as () => void)();
    expect(onSelect).toHaveBeenCalledWith({
      path: "src/Newest.ts",
      line: 9
    });
    const unavailableRow = (
      list?.props?.renderItem as (input: { item: typeof rows[number] }) => ElementNode
    )({ item: rows[3]! });
    expect(unavailableRow.props?.disabled).toBe(true);
    expect(textContent(unavailableRow)).toContain("Unavailable · file not found");
  });

  it("shows bounded-result copy when history or resolution is truncated", async () => {
    const options = {
      history: { ...history, overflow: true },
      resolveMentions: vi.fn().mockResolvedValue({
        mentions: resolution.mentions.map((mention, index) => ({
          ...mention,
          truncated: index === 1
        }))
      })
    };
    renderMentionedFiles(options);
    await runEffects();
    const tree = renderMentionedFiles(options);

    expect(
      textContent(findByType(tree, "FlatList")?.props?.ListFooterComponent)
    ).toContain("More matches may be available");
  });

  it("retries a failed resolution and keeps the modal open", async () => {
    const resolveMentions = vi.fn()
      .mockRejectedValueOnce(new Error("owner unavailable"))
      .mockResolvedValueOnce(resolution);
    const options = { resolveMentions };
    renderMentionedFiles(options);
    await runEffects();
    let tree = renderMentionedFiles(options);
    expect(textContent(tree)).toContain("owner unavailable");

    const retry = findByTestId(tree, MOBILE_E2E_IDS.taskMentionedFilesRetry);
    (retry?.props?.onPress as () => void)();
    tree = renderMentionedFiles(options);
    await runEffects();
    renderMentionedFiles(options);

    expect(resolveMentions).toHaveBeenCalledTimes(2);
  });

  it("does not resolve an empty history", async () => {
    const resolveMentions = vi.fn();
    const options = {
      history: { mentions: [], overflow: false },
      resolveMentions
    };
    const tree = renderMentionedFiles(options);
    await runEffects();

    expect(resolveMentions).not.toHaveBeenCalled();
    expect(textContent(tree)).toContain("No files have been mentioned yet");
  });

  it("ignores a unique result after the history changes", async () => {
    const pending = deferred<TaskFileMentionResolution>();
    const onSelect = vi.fn();
    const initial = {
      history: {
        mentions: [{ raw: "Old.ts", path: "Old.ts" }],
        overflow: false
      },
      autoSelectUnique: true,
      resolveMentions: vi.fn(() => pending.promise),
      onSelect
    };
    renderMentionedFiles(initial);
    await runEffects();

    const replacement = {
      ...initial,
      history: { mentions: [], overflow: false }
    };
    renderMentionedFiles(replacement);
    await runEffects();
    pending.resolve({
      mentions: [{
        path: "Old.ts",
        matches: [{ path: "src/Old.ts" }],
        truncated: false
      }]
    });
    await Promise.resolve();

    expect(onSelect).not.toHaveBeenCalled();
  });

  it("auto-selects one canonical match but renders ambiguous choices", async () => {
    const onSelect = vi.fn();
    const uniqueHistory = {
      mentions: [{ raw: "Only.ts:7", path: "Only.ts", line: 7 }],
      overflow: false
    };
    const unique = {
      mentions: [{
        path: "Only.ts",
        line: 7,
        matches: [{ path: "src/Only.ts" }],
        truncated: false
      }]
    };
    const uniqueOptions = {
      history: uniqueHistory,
      autoSelectUnique: true,
      resolveMentions: vi.fn().mockResolvedValue(unique),
      onSelect
    };
    renderMentionedFiles(uniqueOptions);
    await runEffects();
    expect(onSelect).toHaveBeenCalledWith({ path: "src/Only.ts", line: 7 });

    for (const slot of harness.effectSlots) slot?.cleanup?.();
    harness.effectSlots.length = 0;
    harness.hookIndex = 0;
    harness.pendingEffects.length = 0;
    harness.refs.length = 0;
    harness.states.length = 0;
    const ambiguousOptions = {
      history: uniqueHistory,
      autoSelectUnique: true,
      resolveMentions: vi.fn().mockResolvedValue({
        mentions: [{
          ...unique.mentions[0],
          matches: [{ path: "a/Only.ts" }, { path: "b/Only.ts" }]
        }]
      }),
      onSelect: vi.fn()
    };
    renderMentionedFiles(ambiguousOptions);
    await runEffects();
    const tree = renderMentionedFiles(ambiguousOptions);
    expect((findByType(tree, "FlatList")?.props?.data as unknown[])).toHaveLength(2);
    expect(ambiguousOptions.onSelect).not.toHaveBeenCalled();
  });

  it("shows a disabled unavailable row when direct resolution has no match", async () => {
    const options = {
      history: {
        mentions: [{ raw: "Missing.ts", path: "Missing.ts" }],
        overflow: false
      },
      autoSelectUnique: true,
      resolveMentions: vi.fn().mockResolvedValue({
        mentions: [{
          path: "Missing.ts",
          matches: [],
          truncated: false,
          unavailableReason: "file not found"
        }]
      })
    };
    renderMentionedFiles(options);
    await runEffects();
    const tree = renderMentionedFiles(options);

    const list = findByType(tree, "FlatList");
    const rows = list?.props?.data as Array<{
      available: boolean;
      path: string;
      unavailableReason?: string;
    }>;
    expect(rows).toEqual([{
      available: false,
      mentionPath: "Missing.ts",
      path: "Missing.ts",
      unavailableReason: "file not found"
    }]);
    const row = (
      list?.props?.renderItem as (input: { item: typeof rows[number] }) => ElementNode
    )({ item: rows[0]! });
    expect(row.props?.disabled).toBe(true);
    expect(textContent(row)).toContain("Unavailable · file not found");
  });
});
