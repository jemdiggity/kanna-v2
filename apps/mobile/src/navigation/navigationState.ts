import type {
  InitialState,
  NavigationState,
  PartialState
} from "@react-navigation/native";
import type { MobileView } from "../state/sessionStore";

export type MainTabParamList = {
  Tasks: undefined;
  Activity: undefined;
  More: undefined;
};

export type RootStackParamList = {
  MainTabs: undefined;
  TaskDetail: { taskId: string };
  TaskMore: undefined;
  Search: undefined;
  Desktops: undefined;
};

type ProjectableNavigationState =
  | InitialState
  | NavigationState
  | PartialState<NavigationState>;

const TAB_ROUTE_NAMES = ["Tasks", "Activity", "More"] as const;

export function buildInitialNavigationState(input: {
  activeView: MobileView;
  selectedTaskId: string | null;
}): InitialState {
  const tabName = initialTabName(input.activeView);
  const rootRoutes: InitialState["routes"] = [
    {
      name: "MainTabs",
      state: {
        index: TAB_ROUTE_NAMES.indexOf(tabName),
        routes: TAB_ROUTE_NAMES.map((name) => ({ name }))
      }
    }
  ];

  if (input.activeView === "search") {
    rootRoutes.push({ name: "Search" });
  } else if (input.activeView === "desktops") {
    rootRoutes.push({ name: "Desktops" });
  }

  if (
    input.selectedTaskId &&
    (input.activeView === "tasks" ||
      input.activeView === "recent" ||
      input.activeView === "search")
  ) {
    rootRoutes.push({
      name: "TaskDetail",
      params: { taskId: input.selectedTaskId }
    });
  }

  return {
    index: rootRoutes.length - 1,
    routes: rootRoutes
  };
}

export function projectActiveView(
  state: ProjectableNavigationState | undefined
): MobileView {
  if (!state?.routes.length) return "tasks";

  for (let index = activeIndex(state); index >= 0; index -= 1) {
    const route = state.routes[index];
    if (!route) continue;

    switch (route.name) {
      case "Search":
        return "search";
      case "Desktops":
        return "desktops";
      case "MainTabs":
        return projectMainTab(route.state);
      case "TaskDetail":
      case "TaskMore":
        break;
    }
  }

  return "tasks";
}

function activeIndex(state: ProjectableNavigationState): number {
  const index = state.index ?? state.routes.length - 1;
  return Math.min(Math.max(index, 0), state.routes.length - 1);
}

function projectMainTab(
  state: ProjectableNavigationState | undefined
): MobileView {
  if (!state?.routes.length) return "tasks";
  const activeRoute = state.routes[activeIndex(state)];
  switch (activeRoute?.name) {
    case "Activity":
      return "recent";
    case "More":
      return "more";
    case "Tasks":
    default:
      return "tasks";
  }
}

function initialTabName(view: MobileView): keyof MainTabParamList {
  switch (view) {
    case "recent":
      return "Activity";
    case "more":
    case "desktops":
      return "More";
    case "search":
    case "tasks":
    default:
      return "Tasks";
  }
}
