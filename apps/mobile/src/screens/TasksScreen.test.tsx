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
let TaskList: typeof import("../components/TaskList").TaskList | null = null;

beforeAll(async () => {
  [TasksScreen, TaskList] = await Promise.all([
    import("./TasksScreen").then((module) => module.TasksScreen),
    import("../components/TaskList").then((module) => module.TaskList)
  ]);
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

function findElement(node: ElementNode, type: unknown): ElementNode | null {
  if (node.type === type) return node;
  for (const child of flattenChildren(node.props?.children)) {
    if (typeof child === "string") continue;
    const match = findElement(child, type);
    if (match) return match;
  }
  return null;
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

  it("keeps Recent pan-repo even when the Tasks view has a selected repo", () => {
    if (!TasksScreen || !TaskList) throw new Error("TasksScreen was not loaded");
    const tasks = [
      { id: "task-a", repoId: "repo-a", title: "Task A", stage: "review" },
      { id: "task-b", repoId: "repo-b", title: "Task B", stage: "in progress" }
    ];

    const tree = TasksScreen({
      heading: "Recent",
      repos: [
        { id: "repo-a", name: "Repo A" },
        { id: "repo-b", name: "Repo B" }
      ],
      selectedRepoId: "repo-a",
      tasks,
      onOpenTask: vi.fn(),
      onSelectRepo: vi.fn()
    }) as ElementNode;

    expect(findElement(tree, TaskList)?.props?.tasks).toEqual(tasks);
    expect(textContent(tree)).not.toContain("Repo A");
  });

  it("continues to scope the structural Tasks view to the selected repo", () => {
    if (!TasksScreen || !TaskList) throw new Error("TasksScreen was not loaded");
    const taskA = {
      id: "task-a",
      repoId: "repo-a",
      title: "Task A",
      stage: "review"
    };

    const tree = TasksScreen({
      heading: "Tasks",
      repos: [
        { id: "repo-a", name: "Repo A" },
        { id: "repo-b", name: "Repo B" }
      ],
      selectedRepoId: "repo-a",
      tasks: [
        taskA,
        { id: "task-b", repoId: "repo-b", title: "Task B", stage: "review" }
      ],
      onOpenTask: vi.fn(),
      onSelectRepo: vi.fn()
    }) as ElementNode;

    expect(findElement(tree, TaskList)?.props?.tasks).toEqual([taskA]);
  });
});
