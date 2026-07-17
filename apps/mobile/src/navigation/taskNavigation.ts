export interface TaskNavigationRoute {
  name: string;
  params?: {
    taskId?: string;
  };
}

export type TaskDetailNavigationPlan =
  | { type: "none" }
  | { type: "push" | "replace" | "popTo"; taskId: string };

export function planTaskDetailNavigation(input: {
  routes: readonly TaskNavigationRoute[];
  index?: number;
  taskId: string;
  pendingTaskId: string | null;
}): TaskDetailNavigationPlan {
  if (input.pendingTaskId) {
    return { type: "none" };
  }

  const activeIndex = Math.min(
    Math.max(input.index ?? input.routes.length - 1, 0),
    input.routes.length - 1
  );
  const activeRoutes = input.routes.slice(0, activeIndex + 1);
  const currentRoute = activeRoutes[activeRoutes.length - 1];
  const taskRoute = [...activeRoutes]
    .reverse()
    .find((route) => route.name === "TaskDetail");

  if (currentRoute?.name === "TaskDetail") {
    if (currentRoute.params?.taskId === input.taskId) {
      return { type: "none" };
    }
    return { type: "replace", taskId: input.taskId };
  }

  if (taskRoute) {
    return { type: "popTo", taskId: input.taskId };
  }

  return { type: "push", taskId: input.taskId };
}

export function resolveFocusedTaskRouteIdentity(input: {
  focused: boolean;
  routeTaskExists: boolean;
  routeTaskId: string;
  selectedTaskExists: boolean;
  selectedTaskId: string | null;
}): string {
  return input.focused ? resolveTaskCleanupIdentity(input) : input.routeTaskId;
}

export function resolveTaskCleanupIdentity(input: {
  routeTaskExists: boolean;
  routeTaskId: string;
  selectedTaskExists: boolean;
  selectedTaskId: string | null;
}): string {
  return !input.routeTaskExists &&
    input.selectedTaskExists &&
    input.selectedTaskId
    ? input.selectedTaskId
    : input.routeTaskId;
}

export function resolvePendingTaskCreationRoute(input: {
  composerOpen: boolean;
  pendingSlotId: string | null;
  selectedTaskId: string | null;
}): string | null {
  return !input.composerOpen &&
    input.pendingSlotId !== null &&
    input.selectedTaskId === input.pendingSlotId
    ? input.pendingSlotId
    : null;
}
