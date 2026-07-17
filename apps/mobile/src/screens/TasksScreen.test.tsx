import { beforeAll, describe, expect, it, vi } from "vitest";
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import { projectTaskUiSlots } from "../state/taskUiSlots";

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
let TaskCard: typeof import("../components/TaskCard").TaskCard | null = null;

beforeAll(async () => {
  [TasksScreen, TaskList, TaskCard] = await Promise.all([
    import("./TasksScreen").then((module) => module.TasksScreen),
    import("../components/TaskList").then((module) => module.TaskList),
    import("../components/TaskCard").then((module) => module.TaskCard)
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
      taskSlots: [],
      onOpenTask: vi.fn(),
      onSelectRepo: vi.fn()
    }) as ElementNode;

    expect(textContent(tree)).toContain("Repo One");
  });

  it("keeps Recent pan-repo even when the Tasks view has a selected repo", () => {
    if (!TasksScreen || !TaskList || !TaskCard) throw new Error("TasksScreen was not loaded");
    const tasks = [
      {
        id: "task-a",
        repoId: "repo-a",
        title: "Task A",
        stage: "review",
        createdAt: "2026-07-15T08:00:00.000Z"
      },
      {
        id: "task-b",
        repoId: "repo-b",
        title: "Task B",
        stage: "in progress",
        createdAt: "2026-07-17T08:00:00.000Z"
      }
    ];

    const tree = TasksScreen({
      heading: "Recent",
      repos: [
        { id: "repo-a", name: "Repo A" },
        { id: "repo-b", name: "Repo B" }
      ],
      selectedRepoId: "repo-a",
      taskSlots: projectTaskUiSlots(tasks, []),
      onOpenTask: vi.fn(),
      onSelectRepo: vi.fn()
    }) as ElementNode;

    expect(findElement(tree, TaskList)?.props?.taskSlots).toEqual(
      projectTaskUiSlots(tasks, [])
    );
    expect(tree.props?.testID).toBe(MOBILE_E2E_IDS.recentScreen);
    expect(textContent(tree)).not.toContain("Repo A");
  });

  it("orders Recent tasks by attention state while preserving group order", () => {
    if (!TasksScreen || !TaskList) throw new Error("TasksScreen was not loaded");
    const tasks = [
      {
        id: "working-1",
        repoId: "repo-a",
        title: "Working 1",
        stage: "in progress",
        activity: "working" as const
      },
      {
        id: "unread-1",
        repoId: "repo-a",
        title: "Unread 1",
        stage: "review",
        activity: "unread" as const
      },
      {
        id: "idle-1",
        repoId: "repo-b",
        title: "Idle 1",
        stage: "in progress",
        activity: "idle" as const
      },
      {
        id: "unread-2",
        repoId: "repo-b",
        title: "Unread 2",
        stage: "review",
        activity: "unread" as const
      }
    ];

    const tree = TasksScreen({
      heading: "Recent",
      repos: [],
      selectedRepoId: "repo-a",
      taskSlots: projectTaskUiSlots(tasks, []),
      onOpenTask: vi.fn(),
      onSelectRepo: vi.fn()
    }) as ElementNode;

    expect(
      (findElement(tree, TaskList)?.props?.taskSlots as Array<{
        taskId: string | null;
      }>).map(
        ({ taskId }) => taskId
      )
    ).toEqual(["unread-1", "unread-2", "idle-1", "working-1"]);
  });

  it("orders repo tasks by creation time newest first without mutating input", () => {
    if (!TasksScreen || !TaskList) throw new Error("TasksScreen was not loaded");
    const tasks = [
      {
        id: "task-old",
        repoId: "repo-a",
        title: "Old task",
        stage: "in progress",
        createdAt: "2026-07-15 08:00:00"
      },
      {
        id: "task-new",
        repoId: "repo-a",
        title: "New task",
        stage: "in progress",
        createdAt: "2026-07-17T08:00:00.000Z"
      },
      {
        id: "task-undated",
        repoId: "repo-a",
        title: "Undated task",
        stage: "in progress"
      }
    ];
    const taskSlots = projectTaskUiSlots(tasks, []);

    const tree = TasksScreen({
      heading: "Tasks",
      repos: [{ id: "repo-a", name: "Repo A" }],
      selectedRepoId: "repo-a",
      taskSlots,
      onOpenTask: vi.fn(),
      onSelectRepo: vi.fn()
    }) as ElementNode;

    expect(
      (findElement(tree, TaskList)?.props?.taskSlots as typeof taskSlots).map(
        ({ taskId }) => taskId
      )
    ).toEqual(["task-new", "task-old", "task-undated"]);
    expect(taskSlots.map(({ taskId }) => taskId)).toEqual([
      "task-old",
      "task-new",
      "task-undated"
    ]);
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
      taskSlots: projectTaskUiSlots([
        taskA,
        { id: "task-b", repoId: "repo-b", title: "Task B", stage: "review" }
      ], []),
      onOpenTask: vi.fn(),
      onSelectRepo: vi.fn()
    }) as ElementNode;

    expect(findElement(tree, TaskList)?.props?.taskSlots).toEqual(
      projectTaskUiSlots([taskA], [])
    );
    expect(tree.props?.testID).toBe(MOBILE_E2E_IDS.tasksScreen);
    expect(findElement(tree, TaskList)?.props?.testID).toBeUndefined();
  });

  it("opens an acknowledged task through its stable UI slot id", () => {
    if (!TasksScreen || !TaskList) throw new Error("TasksScreen was not loaded");
    const onOpenTask = vi.fn();
    const [slot] = projectTaskUiSlots(
      [{ id: "task-durable", repoId: "repo-1", title: "Task", stage: "review" }],
      []
    );
    const stableSlot = { ...slot!, slotId: "create:slot-1" };
    const tree = TasksScreen({
      heading: "Recent",
      repos: [],
      selectedRepoId: null,
      taskSlots: [stableSlot],
      onOpenTask,
      onSelectRepo: vi.fn()
    }) as ElementNode;
    const taskListTree = TaskList(findElement(tree, TaskList)?.props as never) as ElementNode;
    const taskCard = findElement(taskListTree, TaskCard);
    const row = TaskCard(taskCard?.props as never) as ElementNode;

    expect(row?.props?.testID).toBe("mobile.task-row.create:slot-1");
    (row?.props?.onPress as (() => void) | undefined)?.();
    expect(onOpenTask).toHaveBeenCalledWith("create:slot-1");
  });
});
