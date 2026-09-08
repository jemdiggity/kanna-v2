import { beforeAll, describe, expect, it, vi } from "vitest";
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import type { TaskCollectionStatus } from "../state/sessionStore";
import type { LocalTaskListPreferences } from "../state/taskListPreferences";
import {
  buildCreatingTaskUiSlot,
  projectTaskUiSlots,
  type TaskUiSlot
} from "../state/taskUiSlots";

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T) => styles
  },
  Text: "Text",
  View: "View"
}));

vi.mock("../components/LoadingText", () => ({
  LoadingText: "LoadingText"
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

function findPressableByText(node: ElementNode, text: string): ElementNode | null {
  if (node.type === "Pressable" && textContent(node) === text) return node;
  for (const child of flattenChildren(node.props?.children)) {
    if (typeof child === "string") continue;
    const match = findPressableByText(child, text);
    if (match) return match;
  }
  return null;
}

function findFunctionElement(
  node: ElementNode,
  name: string
): ElementNode | null {
  if (typeof node.type === "function" && node.type.name === name) return node;
  for (const child of flattenChildren(node.props?.children)) {
    if (typeof child === "string") continue;
    const match = findFunctionElement(child, name);
    if (match) return match;
  }
  return null;
}

function renderFunctionElement(node: ElementNode): ElementNode {
  if (typeof node.type !== "function") {
    throw new Error("Expected a function component");
  }
  const render = node.type as (
    props: ElementNode["props"]
  ) => ElementNode;
  return render(node.props);
}

function renderTasksScreen({
  needsDesktopSetup = false,
  repos = [{ id: "repo-1", name: "Repo One" }],
  taskCollectionStatus = "ready",
  taskSlots = [],
  onOpenMachines = vi.fn()
}: {
  needsDesktopSetup?: boolean;
  repos?: Array<{ id: string; name: string }>;
  taskCollectionStatus?: TaskCollectionStatus;
  taskSlots?: TaskUiSlot[];
  onOpenMachines?: () => void;
} = {}): ElementNode {
  if (!TasksScreen) throw new Error("TasksScreen was not loaded");
  return TasksScreen({
    heading: "Tasks",
    needsDesktopSetup,
    repos,
    selectedRepoId: repos[0]?.id ?? null,
    taskCollectionStatus,
    taskSlots,
    onOpenMachines,
    onOpenTask: vi.fn(),
    onSelectRepo: vi.fn()
  } as never) as ElementNode;
}

describe("TasksScreen", () => {
  it("shows loading instead of an empty state before the first snapshot", () => {
    if (!TaskList) throw new Error("TaskList was not loaded");
    const tree = renderTasksScreen({ taskCollectionStatus: "loading" });
    const taskList = findElement(tree, TaskList);

    expect(taskList?.props).toMatchObject({
      loading: true,
      errorLabel: null
    });

    const renderedList = TaskList(taskList?.props as never) as ElementNode;
    expect(findElement(renderedList, "LoadingText")?.props?.label).toBe(
      "Loading tasks"
    );
    expect(textContent(renderedList)).not.toContain("No tasks yet.");
  });

  it("shows the genuine empty state after a successful empty snapshot", () => {
    if (!TaskList) throw new Error("TaskList was not loaded");
    const tree = renderTasksScreen({ taskCollectionStatus: "ready" });
    const taskList = findElement(tree, TaskList);

    expect(taskList?.props).toMatchObject({
      emptyLabel: "No tasks yet.",
      loading: false
    });
    expect(textContent(TaskList(taskList?.props as never) as ElementNode)).toContain(
      "No tasks yet."
    );
  });

  it("guides a fresh install to pair the macOS companion over the local network", () => {
    const onOpenMachines = vi.fn();
    const tree = renderTasksScreen({
      needsDesktopSetup: true,
      repos: [],
      onOpenMachines
    });
    const setupElement = findFunctionElement(tree, "DesktopSetupEmptyState");
    if (!setupElement) throw new Error("Desktop setup empty state was not rendered");
    const setupTree = renderFunctionElement(setupElement);

    expect(textContent(setupTree)).toContain(
      "Kanna Mobile is a companion to Kanna for macOS."
    );
    expect(textContent(setupTree)).toContain(
      "Install the desktop app from kanna.build first"
    );
    expect(textContent(setupTree)).toContain("scan its pairing QR code");
    expect(textContent(setupTree)).toContain("connect over your local network");
    expect(textContent(setupTree)).toContain(
      "Cloud sign-in for remote access is separate and optional."
    );
    expect(TaskList ? findElement(tree, TaskList) : null).toBeNull();

    const pairButton = findElement(setupTree, "Pressable");
    expect(pairButton?.props).toMatchObject({
      accessibilityLabel: "Pair a Mac",
      accessibilityRole: "button",
      testID: MOBILE_E2E_IDS.tasksPairMacButton
    });
    pairButton?.props?.onPress?.();
    expect(onOpenMachines).toHaveBeenCalledOnce();
  });

  it("shows a static task load failure", () => {
    if (!TaskList) throw new Error("TaskList was not loaded");
    const tree = renderTasksScreen({ taskCollectionStatus: "error" });
    const taskList = findElement(tree, TaskList);

    expect(taskList?.props?.errorLabel).toBe("Could not load tasks.");
    const renderedList = TaskList(taskList?.props as never) as ElementNode;
    expect(textContent(renderedList)).toContain("Could not load tasks.");
    expect(findElement(renderedList, "LoadingText")).toBeNull();
  });

  it("offers retry and dismiss for a repository command task load failure", () => {
    if (!TasksScreen) throw new Error("TasksScreen was not loaded");
    const onRetryRepoCommand = vi.fn();
    const onDismissRepoCommandError = vi.fn();
    const tree = TasksScreen({
      heading: "Tasks",
      repos: [{ id: "repo-1", name: "Repo One" }],
      selectedRepoId: "repo-1",
      taskCollectionStatus: "ready",
      repoCommandErrorMessage: "The launched task could not be loaded.",
      taskSlots: [],
      onOpenTask: vi.fn(),
      onSelectRepo: vi.fn(),
      onRetryRepoCommand,
      onDismissRepoCommandError
    }) as ElementNode;

    expect(textContent(tree)).toContain("Command task unavailable");
    const retry = findPressableByText(tree, "Try Again");
    const dismiss = findPressableByText(tree, "Dismiss");
    retry?.props?.onPress?.();
    dismiss?.props?.onPress?.();
    expect(onRetryRepoCommand).toHaveBeenCalledOnce();
    expect(onDismissRepoCommandError).toHaveBeenCalledOnce();
  });

  it("keeps task content visible while status is loading", () => {
    const taskSlots = projectTaskUiSlots([{
      id: "task-1",
      repoId: "repo-1",
      title: "Visible task",
      stage: "in progress"
    }], []);
    const tree = renderTasksScreen({
      taskCollectionStatus: "loading",
      taskSlots
    });

    expect(findElement(tree, TaskList)?.props?.loading).toBe(false);
  });

  it("lists a single repo so users can see the active repo scope", () => {
    if (!TasksScreen) throw new Error("TasksScreen was not loaded");

    const tree = TasksScreen({
      heading: "Tasks",
      repos: [{ id: "repo-1", name: "Repo One" }],
      selectedRepoId: "repo-1",
      taskCollectionStatus: "ready",
      taskSlots: [],
      onOpenTask: vi.fn(),
      onSelectRepo: vi.fn()
    }) as ElementNode;

    expect(textContent(tree)).toContain("Repo One");
    expect(findPressableByText(tree, "Repo One")?.props).toMatchObject({
      accessibilityRole: "button",
      accessibilityState: { selected: true },
      testID: MOBILE_E2E_IDS.tasksRepo("repo-1")
    });
  });

  it("keeps Recent pan-repo even when the Tasks view has a selected repo", () => {
    if (!TasksScreen || !TaskList || !TaskCard) throw new Error("TasksScreen was not loaded");
    const tasks = [
      {
        id: "task-a",
        repoId: "repo-a",
        title: "Task A",
        stage: "review",
        activity: "unread" as const,
        createdAt: "2026-07-15T08:00:00.000Z"
      },
      {
        id: "task-b",
        repoId: "repo-b",
        title: "Task B",
        stage: "in progress",
        activity: "unread" as const,
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
      taskCollectionStatus: "ready",
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

  it("shows only unread Activity entries while preserving source order", () => {
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
      taskCollectionStatus: "ready",
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
    ).toEqual(["unread-1", "unread-2"]);
  });

  it("labels Recent tasks with their repo so similar titles stay distinguishable", () => {
    if (!TasksScreen || !TaskList || !TaskCard) throw new Error("TasksScreen was not loaded");
    const tasks = [
      {
        id: "task-cloud",
        repoId: "repo-a",
        repoName: "Cloud Repo",
        title: "Fix login",
        stage: "review",
        activity: "unread" as const
      },
      {
        id: "task-lan",
        repoId: "repo-b",
        title: "Fix login",
        stage: "review",
        activity: "unread" as const
      },
      {
        id: "task-unknown",
        repoId: "repo-unknown",
        title: "Fix login",
        stage: "review",
        activity: "unread" as const
      }
    ];

    const tree = TasksScreen({
      heading: "Recent",
      repos: [{ id: "repo-b", name: "Lan Repo" }],
      selectedRepoId: null,
      taskCollectionStatus: "ready",
      taskSlots: projectTaskUiSlots(tasks, []),
      onOpenTask: vi.fn(),
      onSelectRepo: vi.fn()
    }) as ElementNode;

    const taskListProps = findElement(tree, TaskList)?.props;
    const repoLabelForTask = taskListProps?.repoLabelForTask as (
      task: (typeof tasks)[number]
    ) => string | null;
    expect(repoLabelForTask(tasks[0]!)).toBe("Cloud Repo");
    expect(repoLabelForTask(tasks[1]!)).toBe("Lan Repo");
    expect(repoLabelForTask(tasks[2]!)).toBe("repo-unknown");

    const taskListTree = TaskList(taskListProps as never) as ElementNode;
    const taskCard = findElement(taskListTree, TaskCard);
    const cardTree = TaskCard(taskCard?.props as never) as ElementNode;
    expect(textContent(cardTree)).toContain("Cloud Repo");
  });

  it("keeps repo labels off the repo-scoped Tasks view", () => {
    if (!TasksScreen || !TaskList) throw new Error("TasksScreen was not loaded");
    const tree = TasksScreen({
      heading: "Tasks",
      repos: [{ id: "repo-a", name: "Repo A" }],
      selectedRepoId: "repo-a",
      taskCollectionStatus: "ready",
      taskSlots: projectTaskUiSlots(
        [{ id: "task-a", repoId: "repo-a", title: "Task A", stage: "review" }],
        []
      ),
      onOpenTask: vi.fn(),
      onSelectRepo: vi.fn()
    }) as ElementNode;

    expect(findElement(tree, TaskList)?.props?.repoLabelForTask).toBeUndefined();
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
      taskCollectionStatus: "ready",
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

  it("lifts this phone's pinned repo tasks above the newest unpinned ones", () => {
    if (!TasksScreen || !TaskList) throw new Error("TasksScreen was not loaded");
    const tasks = [
      {
        id: "task-newest",
        repoId: "repo-a",
        title: "Newest task",
        stage: "in progress",
        createdAt: "2026-08-18T08:00:00.000Z"
      },
      {
        id: "task-pinned-second",
        repoId: "repo-a",
        title: "Second pin",
        stage: "in progress",
        createdAt: "2026-07-01T08:00:00.000Z"
      },
      {
        id: "task-older",
        repoId: "repo-a",
        title: "Older task",
        stage: "in progress",
        createdAt: "2026-08-01T08:00:00.000Z",
        // What the desktop pinned is not what this phone shows.
        pinned: true,
        pinOrder: 0
      },
      {
        id: "task-pinned-first",
        repoId: "repo-a",
        title: "First pin",
        stage: "in progress",
        createdAt: "2026-06-01T08:00:00.000Z"
      }
    ];
    const taskSlots = projectTaskUiSlots(tasks, []);

    const tree = TasksScreen({
      heading: "Tasks",
      repos: [{ id: "repo-a", name: "Repo A" }],
      selectedRepoId: "repo-a",
      taskCollectionStatus: "ready",
      taskListPreferences: {
        pins: [
          { taskId: "task-pinned-first", repoId: "repo-a" },
          { taskId: "task-pinned-second", repoId: "repo-a" }
        ],
        dismissedActivity: [],
        pinsSeededFromServer: true
      },
      taskSlots,
      onOpenTask: vi.fn(),
      onSelectRepo: vi.fn()
    }) as ElementNode;

    const list = findElement(tree, TaskList);
    expect(
      (list?.props?.taskSlots as typeof taskSlots).map(({ taskId }) => taskId)
    ).toEqual([
      "task-pinned-first",
      "task-pinned-second",
      "task-newest",
      "task-older"
    ]);
    expect(list?.props?.pinnedTaskIds).toEqual([
      "task-pinned-first",
      "task-pinned-second"
    ]);
  });

  it("shows an account-wide singleton pinned at the top without a phone pin", () => {
    if (!TasksScreen || !TaskList) throw new Error("TasksScreen was not loaded");
    const tasks: TaskSummary[] = [
      {
        id: "task-ordinary",
        repoId: "repo-a",
        title: "Ordinary work",
        stage: "in progress",
        createdAt: "2026-06-03T08:00:00.000Z"
      },
      {
        id: "task-merge",
        repoId: "repo-a",
        title: "Merge Master",
        stage: "in progress",
        singletonAgent: "merge",
        createdAt: "2026-06-01T08:00:00.000Z"
      }
    ];
    const taskSlots = projectTaskUiSlots(tasks, []);

    const render = (preferences: LocalTaskListPreferences) =>
      findElement(
        TasksScreen({
          heading: "Tasks",
          repos: [{ id: "repo-a", name: "Repo A" }],
          selectedRepoId: "repo-a",
          taskCollectionStatus: "ready",
          taskListPreferences: preferences,
          taskSlots,
          onOpenTask: vi.fn(),
          onSelectRepo: vi.fn()
        }) as ElementNode,
        TaskList
      );

    const defaulted = render({
      pins: [],
      unpinnedDefaults: [],
      dismissedActivity: [],
      pinsSeededFromServer: true
    });
    expect(defaulted?.props?.pinnedTaskIds).toEqual(["task-merge"]);
    expect(
      (defaulted?.props?.taskSlots as typeof taskSlots).map(({ taskId }) => taskId)
    ).toEqual(["task-merge", "task-ordinary"]);

    // An explicit unpin on this phone turns the default off and keeps it off.
    const unpinned = render({
      pins: [],
      unpinnedDefaults: [{ taskId: "task-merge", repoId: "repo-a" }],
      dismissedActivity: [],
      pinsSeededFromServer: true
    });
    expect(unpinned?.props?.pinnedTaskIds).toEqual([]);
    expect(
      (unpinned?.props?.taskSlots as typeof taskSlots).map(({ taskId }) => taskId)
    ).toEqual(["task-ordinary", "task-merge"]);
  });

  it("hides Activity rows this phone dismissed and brings back newer activity", () => {
    if (!TasksScreen || !TaskList) throw new Error("TasksScreen was not loaded");
    const renderRecent = (activityRevision: number) => {
      const tree = TasksScreen({
        heading: "Recent",
        repos: [{ id: "repo-a", name: "Repo A" }],
        selectedRepoId: "repo-a",
        taskCollectionStatus: "ready",
        taskListPreferences: {
          pins: [],
          dismissedActivity: [
            { taskId: "task-seen", repoId: "repo-a", activityRevision: 4 }
          ],
          pinsSeededFromServer: true
        },
        taskSlots: projectTaskUiSlots(
          [
            {
              id: "task-seen",
              repoId: "repo-a",
              title: "Seen already",
              stage: "review",
              activity: "unread",
              activityRevision
            },
            {
              id: "task-fresh",
              repoId: "repo-a",
              title: "Still unread",
              stage: "review",
              activity: "unread",
              activityRevision: 1
            }
          ],
          []
        ),
        onOpenTask: vi.fn(),
        onSelectRepo: vi.fn()
      }) as ElementNode;
      return (
        findElement(tree, TaskList)?.props?.taskSlots as Array<{
          taskId: string;
        }>
      ).map(({ taskId }) => taskId);
    };

    expect(renderRecent(4)).toEqual(["task-fresh"]);
    expect(renderRecent(5)).toEqual(["task-seen", "task-fresh"]);
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
      taskCollectionStatus: "ready",
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

  it("nests subtasks under their parent with an indented, test-tagged row", () => {
    if (!TasksScreen || !TaskList) throw new Error("TasksScreen was not loaded");
    const collectElements = (
      node: ElementNode,
      type: unknown,
      out: ElementNode[] = []
    ): ElementNode[] => {
      if (node.type === type) out.push(node);
      for (const child of flattenChildren(node.props?.children)) {
        if (typeof child !== "string") collectElements(child, type, out);
      }
      return out;
    };
    const findByTestID = (
      node: ElementNode,
      testID: string
    ): ElementNode | null => {
      if (node.props?.testID === testID) return node;
      for (const child of flattenChildren(node.props?.children)) {
        if (typeof child === "string") continue;
        const match = findByTestID(child, testID);
        if (match) return match;
      }
      return null;
    };

    const tree = TasksScreen({
      heading: "Tasks",
      repos: [{ id: "repo-a", name: "Repo A" }],
      selectedRepoId: "repo-a",
      taskCollectionStatus: "ready",
      taskSlots: projectTaskUiSlots([
        {
          id: "parent",
          repoId: "repo-a",
          title: "Parent task",
          stage: "in progress",
          createdAt: "2026-07-16 08:00:00"
        },
        {
          id: "child",
          repoId: "repo-a",
          title: "Child task",
          stage: "in progress",
          parentTaskId: "parent",
          createdAt: "2026-07-18 08:00:00"
        }
      ], []),
      onOpenTask: vi.fn(),
      onSelectRepo: vi.fn()
    }) as ElementNode;

    const listProps = findElement(tree, TaskList)?.props;
    expect(listProps?.nestSubtasks).toBe(true);

    const renderedList = TaskList(listProps as never) as ElementNode;
    const cards = collectElements(renderedList, TaskCard);
    expect(cards.map((card) => (card.props?.task as { id: string }).id)).toEqual([
      "parent",
      "child"
    ]);
    expect(cards[0]?.props?.isSubtask).toBe(false);
    expect(cards[1]?.props?.isSubtask).toBe(true);
    expect(
      findByTestID(renderedList, MOBILE_E2E_IDS.taskListSubtaskRow("child"))
    ).not.toBeNull();
  });

  it("gives every ready row its desktop-local id and a creating row none", () => {
    if (!TasksScreen || !TaskList || !TaskCard) throw new Error("TasksScreen was not loaded");
    const readySlots = projectTaskUiSlots(
      [
        {
          id: "a6ea6b03",
          repoId: "repo-1",
          title: "Local task",
          stage: "review"
        },
        {
          id: "cloud:desktop-1:repo-1:41ef899e",
          ownerLocalTaskId: "41ef899e",
          repoId: "repo-1",
          title: "Cloud task",
          stage: "review"
        }
      ],
      []
    );
    const creatingSlot = buildCreatingTaskUiSlot({
      slotId: "create:slot-1",
      repoId: "repo-1",
      prompt: "Still being created",
      desktopId: "desktop-1",
      agentProvider: "claude"
    });
    const tree = TasksScreen({
      heading: "Tasks",
      repos: [{ id: "repo-1", name: "Repo One" }],
      selectedRepoId: "repo-1",
      taskCollectionStatus: "ready",
      taskSlots: [...readySlots, creatingSlot],
      onOpenTask: vi.fn(),
      onSelectRepo: vi.fn()
    }) as ElementNode;

    const collectCards = (
      node: ElementNode,
      out: ElementNode[] = []
    ): ElementNode[] => {
      if (node.type === TaskCard) out.push(node);
      for (const child of flattenChildren(node.props?.children)) {
        if (typeof child !== "string") collectCards(child, out);
      }
      return out;
    };
    const renderedList = TaskList(
      findElement(tree, TaskList)?.props as never
    ) as ElementNode;
    expect(collectCards(renderedList).map((card) => card.props?.shortId)).toEqual([
      "a6ea6b03",
      "41ef899e",
      null
    ]);
  });

  it("opens an acknowledged task through its stable UI slot id", () => {
    if (!TasksScreen || !TaskList) throw new Error("TasksScreen was not loaded");
    const onOpenTask = vi.fn();
    const [slot] = projectTaskUiSlots(
      [{
        id: "task-durable",
        repoId: "repo-1",
        title: "Task",
        stage: "review",
        activity: "unread"
      }],
      []
    );
    const stableSlot = { ...slot!, slotId: "create:slot-1" };
    const tree = TasksScreen({
      heading: "Recent",
      repos: [],
      selectedRepoId: null,
      taskCollectionStatus: "ready",
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
