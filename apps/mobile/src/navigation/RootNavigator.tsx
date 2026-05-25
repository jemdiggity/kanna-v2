export type TabName = "tasks" | "desktops" | "recent" | "more";

export interface TabRoute {
  name: TabName;
  label: string;
  icon: string;
}

export interface UtilityAction {
  name: "search" | "create";
  label: string;
  icon: string;
}

export interface RootNavigatorModel {
  initialRouteName: TabName;
  tabs: TabRoute[];
  utilityActions: UtilityAction[];
}

export function createRootNavigator(): RootNavigatorModel {
  return {
    initialRouteName: "tasks",
    tabs: [
      { name: "tasks", label: "Tasks", icon: "home-outline" },
      { name: "recent", label: "Activity", icon: "notifications-outline" },
      { name: "more", label: "More", icon: "ellipsis-horizontal" }
    ],
    utilityActions: [
      { name: "search", label: "Search", icon: "search-outline" },
      { name: "create", label: "Add task", icon: "add" }
    ]
  };
}

export default function RootNavigator(): RootNavigatorModel {
  return createRootNavigator();
}
