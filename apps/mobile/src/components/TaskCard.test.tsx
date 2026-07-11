import { beforeAll, describe, expect, it, vi } from "vitest";

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
    children?: ElementNode | ElementNode[] | string | null;
    [key: string]: unknown;
  };
}

function flattenChildren(
  children: ElementNode | ElementNode[] | string | null | undefined
): Array<ElementNode | string> {
  if (!children) return [];
  if (typeof children === "string") return [children];
  return (Array.isArray(children) ? children : [children]).filter(Boolean);
}

function textContent(node: ElementNode | string | null | undefined): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  return flattenChildren(node.props?.children).map(textContent).join("");
}

function allNodes(node: ElementNode | string | null | undefined): ElementNode[] {
  if (!node || typeof node === "string") return [];
  return [
    node,
    ...flattenChildren(node.props?.children).flatMap((child) => allNodes(child))
  ];
}

describe("TaskCard", () => {
  it("renders only stage, bounded title, and waiting prompt", () => {
    if (!TaskCard) throw new Error("TaskCard was not loaded");
    const tree = TaskCard({
      task: {
        id: "task-1",
        repoId: "repo-1",
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

    const textNodes = allNodes(tree).filter((node) => node.type === "Text");
    const title = textNodes.find((node) => textContent(node) === "Current title");
    const prompt = textNodes.find(
      (node) => textContent(node) === "Please confirm the final UI."
    );
    expect(title?.props?.numberOfLines).toBe(2);
    expect(prompt?.props?.numberOfLines).toBe(3);
    expect(tree.props?.testID).toBe("mobile.task-row.task-1");
    expect(tree.props?.accessibilityRole).toBe("button");
    expect(tree.props?.accessibilityLabel).toBe(
      "Current title. review. Please confirm the final UI."
    );
  });

  it("styles the pre-capture ellipsis as a muted placeholder", () => {
    if (!TaskCard) throw new Error("TaskCard was not loaded");
    const tree = TaskCard({
      task: {
        id: "task-2",
        repoId: "repo-1",
        title: "New task",
        stage: "in progress"
      },
      onPress: vi.fn()
    }) as ElementNode;

    const placeholder = allNodes(tree).find(
      (node) => node.type === "Text" && textContent(node) === "…"
    );
    expect(placeholder?.props?.style).toContainEqual({ color: "#6F819E" });
  });
});
