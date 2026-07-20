export type TabName = "tasks" | "desktops" | "recent" | "more";

export interface TabRoute {
  name: TabName;
  routeName: "Tasks" | "Activity" | "More";
  label: string;
  icon: string;
}

export interface UtilityAction {
  name: "search" | "create";
  label: string;
  icon: string;
}

export const MAIN_TAB_ROUTES: TabRoute[] = [
  {
    name: "tasks",
    routeName: "Tasks",
    label: "Tasks",
    icon: "home-outline"
  },
  {
    name: "recent",
    routeName: "Activity",
    label: "Activity",
    icon: "notifications-outline"
  },
  {
    name: "more",
    routeName: "More",
    label: "More",
    icon: "ellipsis-horizontal"
  }
];

export const ROOT_STACK_ROUTES = [
  "MainTabs",
  "TaskDetail",
  "Search",
  "Desktops"
] as const;

export const UTILITY_ACTIONS: UtilityAction[] = [
  { name: "search", label: "Search", icon: "search-outline" },
  { name: "create", label: "Add task", icon: "add" }
];

export interface RootNavigatorModel {
  initialRouteName: "tasks";
  tabs: TabRoute[];
  utilityActions: UtilityAction[];
}

export function createRootNavigator(): RootNavigatorModel {
  return {
    initialRouteName: "tasks",
    tabs: MAIN_TAB_ROUTES,
    utilityActions: UTILITY_ACTIONS
  };
}
