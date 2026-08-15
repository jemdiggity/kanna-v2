import { beforeAll, describe, expect, it, vi } from "vitest";
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import type { TaskActivity, TaskSummary } from "../lib/api/types";

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T) => styles
  },
  Text: "Text",
  View: "View"
}));

let TaskCard: typeof import("./TaskCard").TaskCard | null = null;

beforeAll(async () => {
  TaskCard = (await import("./TaskCard")).TaskCard;
});

interface ElementNode {
  type: unknown;
  props?: {
    children?: ElementChild | ElementChild[];
    style?: unknown;
    [key: string]: unknown;
  };
}

type ElementChild = ElementNode | string | number | null | undefined | false;

function flattenChildren(
  children: ElementChild | ElementChild[]
): ElementChild[] {
  return (Array.isArray(children) ? children : [children]).filter(
    (child) => child !== null && child !== undefined && child !== false
  );
}

function textContent(node: ElementChild | ElementChild[]): string {
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (node === null || node === undefined || node === false) return "";
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  return flattenChildren(node.props?.children).map(textContent).join("");
}

function findTextNodeByCompleteText(
  node: ElementChild,
  expectedText: string
): ElementNode | null {
  if (!node || typeof node !== "object") return null;
  if (node.type === "Text" && textContent(node) === expectedText) return node;

  for (const child of flattenChildren(node.props?.children)) {
    const match = findTextNodeByCompleteText(child, expectedText);
    if (match) return match;
  }

  return null;
}

function findNodeByProp(
  node: ElementChild,
  prop: string,
  expectedValue: unknown
): ElementNode | null {
  if (!node || typeof node !== "object") return null;
  if (node.props?.[prop] === expectedValue) return node;

  for (const child of flattenChildren(node.props?.children)) {
    const match = findNodeByProp(child, prop, expectedValue);
    if (match) return match;
  }

  return null;
}

function flattenStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return style.reduce<Record<string, unknown>>(
      (effectiveStyle, item) => ({
        ...effectiveStyle,
        ...flattenStyle(item)
      }),
      {}
    );
  }

  return style && typeof style === "object"
    ? (style as Record<string, unknown>)
    : {};
}

function renderTaskCard(activity?: TaskActivity): ElementNode {
  if (!TaskCard) throw new Error("TaskCard was not loaded");

  const task: TaskSummary = {
    id: "task-1",
    repoId: "repo-1",
    title: "Match desktop typography",
    stage: "in progress",
    ...(activity === undefined ? {} : { activity })
  };

  return TaskCard({
    task,
    onPress: vi.fn()
  }) as ElementNode;
}

describe("TaskCard", () => {
  it("keeps the automation id separate from its human-readable accessibility label", () => {
    if (!TaskCard) throw new Error("TaskCard was not loaded");

    const tree = TaskCard({
      task: {
        id: "task-1",
        repoId: "repo-1",
        title: "Repair cloud task sync",
        stage: "review"
      },
      onPress: vi.fn()
    }) as { props: Record<string, unknown> };

    expect(tree.props.testID).toBe("mobile.task-row.task-1");
    expect(tree.props.accessibilityLabel).toContain("Repair cloud task sync");
    expect(tree.props.accessibilityLabel).not.toBe("mobile.task-row.task-1");
  });

  it("shows a blocked badge and announces it for blocked tasks", () => {
    if (!TaskCard) throw new Error("TaskCard was not loaded");

    const blockedTree = TaskCard({
      task: {
        id: "task-1",
        repoId: "repo-1",
        title: "Waiting task",
        stage: "in progress",
        blockedByTaskIds: ["task-blocker"]
      },
      onPress: vi.fn()
    }) as ElementNode;
    expect(textContent(blockedTree)).toContain("blocked");
    expect(
      (blockedTree.props as Record<string, unknown>).accessibilityLabel
    ).toContain("Blocked");

    const unblockedTree = TaskCard({
      task: {
        id: "task-1",
        repoId: "repo-1",
        title: "Waiting task",
        stage: "in progress",
        blockedByTaskIds: []
      },
      onPress: vi.fn()
    }) as ElementNode;
    expect(textContent(unblockedTree)).not.toContain("blocked");
  });

  it("renders only the title, stage, and waiting prompt text", () => {
    if (!TaskCard) throw new Error("TaskCard was not loaded");

    const tree = TaskCard({
      task: {
        id: "task-1",
        repoId: "repo-1",
        repoName: "Repository label must stay hidden",
        title: "Current title",
        stage: "review",
        waitingPromptSnippet: "Please confirm the final UI."
      },
      onPress: vi.fn()
    }) as ElementNode;

    const text = textContent(tree);
    expect(text).toContain("Current title");
    expect(text).toContain("review");
    expect(text).toContain("Please confirm the final UI.");
    expect(text.toUpperCase()).not.toContain("TASK");
    expect(text.toUpperCase()).not.toContain("RECENT");
    expect(text).not.toContain("repo-1");
    expect(text).not.toContain("Repository label must stay hidden");

    const title = findTextNodeByCompleteText(tree, "Current title");
    const waitingPrompt = findTextNodeByCompleteText(
      tree,
      "Please confirm the final UI."
    );
    expect(title?.props?.numberOfLines).toBe(2);
    expect(waitingPrompt?.props?.numberOfLines).toBe(3);
    expect(tree.props?.accessibilityRole).toBe("button");
    expect(tree.props?.accessibilityLabel).toBe(
      "Current title. review. Please confirm the final UI."
    );
  });

  it("renders an opt-in repo label and announces it after the title", () => {
    if (!TaskCard) throw new Error("TaskCard was not loaded");

    const tree = TaskCard({
      task: {
        id: "task-1",
        repoId: "repo-1",
        title: "Current title",
        stage: "review",
        waitingPromptSnippet: "Please confirm the final UI."
      },
      repoLabel: "kanna-7",
      onPress: vi.fn()
    }) as ElementNode;

    const repoLabel = findTextNodeByCompleteText(tree, "kanna-7");
    expect(repoLabel).not.toBeNull();
    expect(repoLabel?.props?.numberOfLines).toBe(1);
    expect(tree.props?.accessibilityLabel).toBe(
      "Current title. kanna-7. review. Please confirm the final UI."
    );
  });

  it("announces pinned state and exposes a labeled non-swipe action", () => {
    if (!TaskCard) throw new Error("TaskCard was not loaded");
    const onToggle = vi.fn();
    const tree = TaskCard({
      task: {
        id: "task-1",
        repoId: "repo-1",
        title: "Pinned task",
        stage: "review",
        pinned: true
      },
      pinAction: { error: null, pendingPinned: null, onToggle },
      onPress: vi.fn()
    }) as ElementNode;

    expect(tree.props?.accessibilityLabel).toBe(
      "Pinned. Pinned task. review. …"
    );
    expect(tree.props?.accessibilityActions).toEqual([
      { name: "unpin", label: "Unpin" }
    ]);
    const button = findTextNodeByCompleteText(tree, "Unpin");
    expect(button).not.toBeNull();
  });

  it.each([
    {
      optimisticPinned: true,
      pendingPinned: true,
      pendingLabel: "Pinning…"
    },
    {
      optimisticPinned: false,
      pendingPinned: false,
      pendingLabel: "Unpinning…"
    }
  ])(
    "renders and announces $pendingLabel after the optimistic task rerender",
    ({ optimisticPinned, pendingPinned, pendingLabel }) => {
      if (!TaskCard) throw new Error("TaskCard was not loaded");
      const tree = TaskCard({
        task: {
          id: "task-1",
          repoId: "repo-1",
          title: "Pending task",
          stage: "review",
          pinned: optimisticPinned
        },
        pinAction: { error: null, pendingPinned, onToggle: vi.fn() },
        onPress: vi.fn()
      }) as ElementNode;
      const button = findNodeByProp(
        tree,
        "testID",
        MOBILE_E2E_IDS.taskPinButton("task-1")
      );

      expect(button).not.toBeNull();
      expect(textContent(button ?? null)).toBe(pendingLabel);
      expect(button?.props?.accessibilityLabel).toBe(
        `${pendingLabel} Pending task`
      );
      expect(button?.props?.accessibilityState).toEqual({
        busy: true,
        disabled: true
      });
    }
  );

  it("renders a normalized multiline prompt only once in text and accessibility", () => {
    if (!TaskCard) throw new Error("TaskCard was not loaded");

    const title = "Fix the duplicated\n  mobile task prompt";
    const duplicatePrompt = "Fix the duplicated mobile task prompt";
    const tree = TaskCard({
      task: {
        id: "task-1",
        repoId: "repo-1",
        title,
        stage: "in progress",
        waitingPromptSnippet: duplicatePrompt
      },
      onPress: vi.fn()
    }) as ElementNode;

    expect(textContent(tree)).toBe(`${title}in progress`);
    expect(tree.props?.accessibilityLabel).toBe(`${title}. in progress`);
  });

  it("styles the pre-capture ellipsis as a muted placeholder", () => {
    const tree = renderTaskCard();
    const placeholder = findTextNodeByCompleteText(tree, "…");

    expect(flattenStyle(placeholder?.props?.style)).toMatchObject({
      color: "#6F819E"
    });
  });

  it.each([
    ["working", "working"],
    ["unread", "unread"],
    ["idle", "idle"],
    [undefined, "idle"],
  ] as const)(
    "exposes %s activity through a stable native accessibility value",
    (activity, expectedActivity) => {
      expect(renderTaskCard(activity).props?.accessibilityValue).toEqual({
        text: expectedActivity,
      });
    },
  );

  it.each<{
    activity: TaskActivity | undefined;
    expectedFontWeight: "bold" | "normal";
    expectedFontStyle: "italic" | "normal";
  }>([
    {
      activity: "unread",
      expectedFontWeight: "bold",
      expectedFontStyle: "normal"
    },
    {
      activity: "working",
      expectedFontWeight: "normal",
      expectedFontStyle: "italic"
    },
    {
      activity: "idle",
      expectedFontWeight: "normal",
      expectedFontStyle: "normal"
    },
    {
      activity: undefined,
      expectedFontWeight: "normal",
      expectedFontStyle: "normal"
    }
  ])(
    "renders $activity activity with desktop-equivalent title typography",
    ({ activity, expectedFontWeight, expectedFontStyle }) => {
      const tree = renderTaskCard(activity);
      const title = findTextNodeByCompleteText(
        tree,
        "Match desktop typography"
      );

      expect(title).not.toBeNull();
      expect(flattenStyle(title?.props?.style)).toMatchObject({
        fontWeight: expectedFontWeight,
        fontStyle: expectedFontStyle
      });
    }
  );
});
