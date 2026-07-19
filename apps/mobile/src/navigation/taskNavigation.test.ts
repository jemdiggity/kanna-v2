import { describe, expect, it } from "vitest";
import {
  planTaskDetailNavigation,
  resolveFocusedTaskRouteIdentity,
  resolvePendingTaskCreationRoute,
  resolveTaskCleanupIdentity
} from "./taskNavigation";

describe("planTaskDetailNavigation", () => {
  it("suppresses a duplicate request while the first route transition is pending", () => {
    expect(planTaskDetailNavigation({
      routes: [{ name: "MainTabs" }],
      taskId: "task-a",
      pendingTaskId: "task-a"
    })).toEqual({ type: "none" });
  });

  it("does not push a second copy of the visible task detail", () => {
    expect(planTaskDetailNavigation({
      routes: [
        { name: "MainTabs" },
        { name: "TaskDetail", params: { taskId: "task-a" } }
      ],
      taskId: "task-a",
      pendingTaskId: null
    })).toEqual({ type: "none" });
  });

  it("replaces a visible task detail when a different task becomes active", () => {
    expect(planTaskDetailNavigation({
      routes: [
        { name: "MainTabs" },
        { name: "TaskDetail", params: { taskId: "task-a" } }
      ],
      taskId: "task-b",
      pendingTaskId: null
    })).toEqual({ type: "replace", taskId: "task-b" });
  });

  it("returns to the existing detail route from a covering screen", () => {
    expect(planTaskDetailNavigation({
      routes: [
        { name: "MainTabs" },
        { name: "TaskDetail", params: { taskId: "task-a" } },
        { name: "Search" }
      ],
      taskId: "task-b",
      pendingTaskId: null
    })).toEqual({ type: "popTo", taskId: "task-b" });
  });

  it("pushes detail when the stack has no task route", () => {
    expect(planTaskDetailNavigation({
      routes: [{ name: "MainTabs" }, { name: "Search" }],
      taskId: "task-a",
      pendingTaskId: null
    })).toEqual({ type: "push", taskId: "task-a" });
  });
});

describe("resolveTaskCleanupIdentity", () => {
  it("tracks canonical ownership while the detail route is covered", () => {
    expect(resolveTaskCleanupIdentity({
      routeTaskExists: false,
      routeTaskId: "task-provisional",
      selectedTaskExists: true,
      selectedTaskId: "task-canonical"
    })).toBe("task-canonical");
  });
});

describe("resolveFocusedTaskRouteIdentity", () => {
  it("follows a live provisional-to-canonical identity migration", () => {
    expect(resolveFocusedTaskRouteIdentity({
      focused: true,
      routeTaskExists: false,
      routeTaskId: "task-provisional",
      selectedTaskExists: true,
      selectedTaskId: "task-canonical"
    })).toBe("task-canonical");
  });

  it("does not steal a valid route merely because global selection changed", () => {
    expect(resolveFocusedTaskRouteIdentity({
      focused: true,
      routeTaskExists: true,
      routeTaskId: "task-a",
      selectedTaskExists: true,
      selectedTaskId: "task-b"
    })).toBe("task-a");
  });

  it("does not synchronize a route while it is covered by another screen", () => {
    expect(resolveFocusedTaskRouteIdentity({
      focused: false,
      routeTaskExists: false,
      routeTaskId: "task-provisional",
      selectedTaskExists: true,
      selectedTaskId: "task-canonical"
    })).toBe("task-provisional");
  });
});

describe("resolvePendingTaskCreationRoute", () => {
  it("opens the optimistic workspace as soon as its durable slot is selected", () => {
    expect(resolvePendingTaskCreationRoute({
      composerOpen: false,
      pendingSlotId: "create:slot-1",
      selectedTaskId: "create:slot-1"
    })).toBe("create:slot-1");
  });

  it.each([
    [true, "create:slot-1", "create:slot-1"],
    [false, null, "create:slot-1"],
    [false, "create:slot-1", "task-other"]
  ] as const)(
    "does not route before submission or without the selected pending slot",
    (composerOpen, pendingSlotId, selectedTaskId) => {
      expect(resolvePendingTaskCreationRoute({
        composerOpen,
        pendingSlotId,
        selectedTaskId
      })).toBeNull();
    }
  );
});
