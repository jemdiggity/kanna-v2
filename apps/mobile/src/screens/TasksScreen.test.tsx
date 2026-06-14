import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T) => styles
  },
  Text: "Text",
  View: "View"
}));

let TasksScreen: typeof import("./TasksScreen").TasksScreen | null = null;

beforeAll(async () => {
  TasksScreen = (await import("./TasksScreen")).TasksScreen;
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

describe("TasksScreen", () => {
  it("lists a single repo so users can see the active repo scope", () => {
    if (!TasksScreen) throw new Error("TasksScreen was not loaded");

    const tree = TasksScreen({
      heading: "Tasks",
      repos: [{ id: "repo-1", name: "Repo One" }],
      selectedRepoId: "repo-1",
      tasks: [],
      onOpenTask: vi.fn(),
      onSelectRepo: vi.fn()
    }) as ElementNode;

    expect(textContent(tree)).toContain("Repo One");
  });
});
