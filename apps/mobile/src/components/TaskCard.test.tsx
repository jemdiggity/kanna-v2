import { beforeAll, describe, expect, it, vi } from "vitest";
import type { TaskActivity, TaskSummary } from "../lib/api/types";
import {
  TASK_BLOCKED_THEME,
  TASK_STAGE_STRIPE_WIDTH,
  resolveTaskStageTheme
} from "../theme/taskStageTheme";

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

function findImmediateParent(
  node: ElementChild,
  target: ElementNode | null
): ElementNode | null {
  if (!node || typeof node !== "object" || !target) return null;
  const children = flattenChildren(node.props?.children);
  if (children.includes(target)) return node;
  for (const child of children) {
    const match = findImmediateParent(child, target);
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

  it("announces pinned state and keeps pin reachable without a pin button", () => {
    if (!TaskCard) throw new Error("TaskCard was not loaded");
    const onToggle = vi.fn();
    const tree = TaskCard({
      task: {
        id: "task-1",
        repoId: "repo-1",
        title: "Pinned task",
        stage: "review"
      },
      pinned: true,
      pinAction: { error: null, onToggle },
      onPress: vi.fn()
    }) as ElementNode;

    expect(tree.props?.accessibilityLabel).toBe(
      "Pinned. Pinned task. review. …"
    );
    expect(tree.props?.accessibilityActions).toEqual([
      { name: "unpin", label: "Unpin" }
    ]);
    // Swiping is the only pin affordance, so the card renders no pin control.
    expect(findTextNodeByCompleteText(tree, "Unpin")).toBeNull();
    expect(
      findNodeByProp(tree, "testID", "mobile.task-pin-button.task-1")
    ).toBeNull();

    const handleAccessibilityAction = tree.props?.onAccessibilityAction as (
      event: { nativeEvent: { actionName: string } }
    ) => void;
    handleAccessibilityAction({ nativeEvent: { actionName: "unpin" } });
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("marks a pinned row with a distinct outline rather than a glyph", () => {
    if (!TaskCard) throw new Error("TaskCard was not loaded");
    const task: TaskSummary = {
      id: "task-1",
      repoId: "repo-1",
      title: "Pinned task",
      stage: "review"
    };
    const theme = resolveTaskStageTheme("review");
    const unpinned = TaskCard({ task, onPress: vi.fn() }) as ElementNode;
    const pinned = TaskCard({
      task,
      pinned: true,
      onPress: vi.fn()
    }) as ElementNode;

    const unpinnedBorder = flattenStyle(unpinned.props?.style).borderColor;
    const pinnedBorder = flattenStyle(pinned.props?.style).borderColor;
    // Stage colour and pin state are orthogonal: both rows keep the stage's
    // hue, and only the pinned one wears it at full strength.
    expect(unpinnedBorder).toBe(theme.border);
    expect(pinnedBorder).toBe(theme.pinnedBorder);
    expect(pinnedBorder).not.toBe(unpinnedBorder);
    expect(flattenStyle(pinned.props?.style).borderLeftColor).toBe(
      flattenStyle(unpinned.props?.style).borderLeftColor
    );
    // The outline carries it on its own: no pin glyph joins the stage pill.
    expect(textContent(pinned)).toBe(textContent(unpinned));
  });

  it.each(["in progress", "review", "pr", "somewhere-custom", null])(
    "colours the %j row from its stage theme",
    (stage) => {
      if (!TaskCard) throw new Error("TaskCard was not loaded");
      const theme = resolveTaskStageTheme(stage);
      const tree = TaskCard({
        task: {
          id: "task-1",
          repoId: "repo-1",
          title: "Coloured row",
          stage
        },
        onPress: vi.fn()
      }) as ElementNode;

      const cardStyle = flattenStyle(tree.props?.style);
      expect(cardStyle.backgroundColor).toBe(theme.surface);
      expect(cardStyle.borderColor).toBe(theme.border);
      // The saturated left edge is the stage signal that reads from a scroll.
      expect(cardStyle.borderLeftColor).toBe(theme.accent);
      expect(cardStyle.borderLeftWidth).toBe(TASK_STAGE_STRIPE_WIDTH);

      const stageLabel = findTextNodeByCompleteText(
        tree,
        stage ?? "unknown"
      );
      expect(flattenStyle(stageLabel?.props?.style).color).toBe(
        theme.chipLabel
      );
    }
  );

  it("keeps the blocked badge on its own colour over the stage colour", () => {
    if (!TaskCard) throw new Error("TaskCard was not loaded");
    const tree = TaskCard({
      task: {
        id: "task-1",
        repoId: "repo-1",
        title: "Blocked task",
        stage: "in progress",
        blockedByTaskIds: ["task-blocker"]
      },
      onPress: vi.fn()
    }) as ElementNode;

    const blockedLabel = findTextNodeByCompleteText(tree, "blocked");
    expect(flattenStyle(blockedLabel?.props?.style).color).toBe(
      TASK_BLOCKED_THEME.chipLabel
    );
    expect(TASK_BLOCKED_THEME.chipLabel).not.toBe(
      resolveTaskStageTheme("in progress").chipLabel
    );
  });

  it("keeps Activity dismissal on the row's accessibility actions with no button", () => {
    if (!TaskCard) throw new Error("TaskCard was not loaded");
    const onDismiss = vi.fn();
    const tree = TaskCard({
      task: {
        id: "task-activity",
        repoId: "repo-1",
        title: "Unread activity",
        stage: "review",
        activity: "unread"
      },
      dismissAction: { error: null, onDismiss },
      onPress: vi.fn()
    }) as ElementNode;

    expect(tree.props?.accessibilityActions).toEqual([
      { name: "dismiss", label: "Dismiss" }
    ]);
    // Swiping is the only dismiss affordance, exactly like pinning.
    expect(findTextNodeByCompleteText(tree, "Dismiss")).toBeNull();

    const handleAccessibilityAction = tree.props?.onAccessibilityAction as (
      event: { nativeEvent: { actionName: string } }
    ) => void;
    handleAccessibilityAction({ nativeEvent: { actionName: "dismiss" } });
    expect(onDismiss).toHaveBeenCalledOnce();
  });

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

  it("keeps the id separate from a row whose title has to truncate", () => {
    if (!TaskCard) throw new Error("TaskCard was not loaded");

    const longTitle = `Long ${"mobile task title ".repeat(12)}end`;
    const tree = TaskCard({
      task: {
        id: "a6ea6b03",
        repoId: "repo-1",
        title: longTitle,
        stage: "in progress"
      },
      shortId: "a6ea6b03",
      onPress: vi.fn()
    }) as ElementNode;

    // The id is its own element, so nothing about it depends on title length.
    const renderedId = findNodeByProp(
      tree,
      "testID",
      "mobile.task-row-id.a6ea6b03"
    );
    expect(textContent(renderedId)).toBe("a6ea6b03");
    expect(renderedId?.props).toMatchObject({
      ellipsizeMode: "middle",
      numberOfLines: 1
    });
    // The title is what gives: it truncates with an ellipsis, and the id is
    // not part of the string that truncated.
    const title = findNodeByProp(tree, "numberOfLines", 2);
    expect(textContent(title)).not.toContain("a6ea6b03");
    expect(textContent(title).endsWith("…")).toBe(true);
    expect(tree.props?.accessibilityLabel).toContain("Task ID a6ea6b03");
  });

  it("renders a short-title row with its title intact beside the same id", () => {
    if (!TaskCard) throw new Error("TaskCard was not loaded");

    const tree = TaskCard({
      task: {
        id: "a6ea6b03",
        repoId: "repo-1",
        title: "Short title",
        stage: "in progress"
      },
      shortId: "a6ea6b03",
      onPress: vi.fn()
    }) as ElementNode;

    expect(findTextNodeByCompleteText(tree, "Short title")).not.toBeNull();
    expect(
      findNodeByProp(tree, "testID", "mobile.task-row-id.a6ea6b03")
    ).not.toBeNull();
    expect(tree.props?.accessibilityLabel).toBe(
      "Short title. Task ID a6ea6b03. in progress. …"
    );
  });

  it("renders no id when the row has none to show yet", () => {
    if (!TaskCard) throw new Error("TaskCard was not loaded");

    const tree = TaskCard({
      task: {
        id: "local-slot-1",
        repoId: "repo-1",
        title: "Creating task",
        stage: "in progress"
      },
      shortId: null,
      onPress: vi.fn()
    }) as ElementNode;

    expect(textContent(tree)).not.toContain("local-slot-1");
    expect(tree.props?.accessibilityLabel).not.toContain("Task ID");
  });

  it("keeps a current 64-hex id from displacing the stored title", () => {
    if (!TaskCard) throw new Error("TaskCard was not loaded");

    const mobileCreatedId =
      "3235f764375599b803c5751e2da246629ee062bf4df34ea4380c1c709243d349";
    const storedTitle =
      "Check how PR787 aligns with merged BLE OTA work";

    const tree = TaskCard({
      task: {
        id: mobileCreatedId,
        repoId: "repo-1",
        title: storedTitle,
        prompt: "A different canonical prompt",
        stage: "pr"
      },
      shortId: mobileCreatedId,
      onPress: vi.fn()
    }) as ElementNode;

    const titleNode = findTextNodeByCompleteText(tree, storedTitle);
    expect(titleNode).not.toBeNull();
    const idNode = findNodeByProp(
      tree,
      "testID",
      `mobile.task-row-id.${mobileCreatedId}`
    );
    expect(textContent(idNode)).toBe(mobileCreatedId);
    expect(idNode?.props).toMatchObject({
      ellipsizeMode: "middle",
      numberOfLines: 1
    });
    expect(flattenStyle(idNode?.props?.style)).toMatchObject({
      alignSelf: "flex-end",
      maxWidth: "100%"
    });
    expect(findImmediateParent(tree, titleNode)).not.toBe(
      findImmediateParent(tree, idNode)
    );
  });

  it("uses a prompt excerpt instead of a 64-hex id when the title is blank", () => {
    if (!TaskCard) throw new Error("TaskCard was not loaded");

    const mobileCreatedId =
      "3235f764375599b803c5751e2da246629ee062bf4df34ea4380c1c709243d349";
    const tree = TaskCard({
      task: {
        id: mobileCreatedId,
        repoId: "repo-1",
        title: "   ",
        prompt: "\n  Check the BLE OTA behavior\nAdditional detail",
        stage: "pr"
      },
      onPress: vi.fn()
    }) as ElementNode;

    expect(
      findTextNodeByCompleteText(tree, "Check the BLE OTA behavior")
    ).not.toBeNull();
    expect(tree.props?.accessibilityLabel).not.toContain(mobileCreatedId);
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
