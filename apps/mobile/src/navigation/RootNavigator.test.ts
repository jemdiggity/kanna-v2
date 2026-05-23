import { describe, expect, it } from "vitest";
import { createRootNavigator } from "./RootNavigator";

describe("createRootNavigator", () => {
  it("orders the mobile shell tabs like the compact bottom navigation", () => {
    const navigator = createRootNavigator();

    expect(navigator.tabs).toEqual([
      { name: "tasks", label: "Tasks", icon: "home-outline" },
      { name: "recent", label: "Activity", icon: "notifications-outline" },
      { name: "more", label: "More", icon: "ellipsis-horizontal" }
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
