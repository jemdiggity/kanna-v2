import { describe, expect, it } from "vitest";
import {
  createRootNavigator,
  MAIN_TAB_ROUTES,
  ROOT_STACK_ROUTES
} from "./navigationConfig";

describe("canonical route inventory", () => {
  it("uses ordinary bottom tabs inside the root stack", () => {
    expect(MAIN_TAB_ROUTES.map(({ routeName }) => routeName)).toEqual([
      "Tasks",
      "Activity",
      "More"
    ]);
    expect(ROOT_STACK_ROUTES).toEqual([
      "MainTabs",
      "TaskDetail",
      "TaskMore",
      "Search",
      "Desktops"
    ]);
  });
});

describe("createRootNavigator", () => {
  it("orders the mobile shell tabs like the compact bottom navigation", () => {
    const navigator = createRootNavigator();

    expect(navigator.tabs).toEqual([
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
    ]);
  });

  it("uses icon-first utility actions for search and task creation", () => {
    const navigator = createRootNavigator();

    expect(navigator.utilityActions).toEqual([
      { name: "search", label: "Search", icon: "search-outline" },
      { name: "create", label: "Add task", icon: "add" }
    ]);
  });
});
