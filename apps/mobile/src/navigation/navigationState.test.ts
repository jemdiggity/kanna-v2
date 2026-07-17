import type { InitialState } from "@react-navigation/native";
import { describe, expect, it } from "vitest";
import {
  buildInitialNavigationState,
  projectActiveView
} from "./navigationState";

function rootRoutes(state: InitialState) {
  return state.routes;
}

function rootRouteNames(state: InitialState): string[] {
  return rootRoutes(state).map((route) => route.name);
}

function activeMainTab(state: InitialState): string | null {
  const tabs = rootRoutes(state).find((route) => route.name === "MainTabs")?.state;
  if (!tabs?.routes?.length) return null;
  return tabs.routes[tabs.index ?? 0]?.name ?? null;
}

describe("buildInitialNavigationState", () => {
  it.each([
    ["tasks", "Tasks"],
    ["recent", "Activity"],
    ["more", "More"]
  ] as const)("restores the %s projection as the %s tab", (activeView, tab) => {
    const state = buildInitialNavigationState({
      activeView,
      selectedTaskId: null
    });

    expect(rootRouteNames(state)).toEqual(["MainTabs"]);
    expect(activeMainTab(state)).toBe(tab);
    expect(projectActiveView(state)).toBe(activeView);
  });

  it("restores task detail above Activity and projects Activity while detail is active", () => {
    const state = buildInitialNavigationState({
      activeView: "recent",
      selectedTaskId: "task-activity"
    });

    expect(rootRouteNames(state)).toEqual(["MainTabs", "TaskDetail"]);
    expect(activeMainTab(state)).toBe("Activity");
    expect(rootRoutes(state)[1]?.params).toEqual({ taskId: "task-activity" });
    expect(projectActiveView(state)).toBe("recent");
  });

  it("restores task detail above Search without losing the Search origin", () => {
    const state = buildInitialNavigationState({
      activeView: "search",
      selectedTaskId: "task-search"
    });

    expect(rootRouteNames(state)).toEqual([
      "MainTabs",
      "Search",
      "TaskDetail"
    ]);
    expect(projectActiveView(state)).toBe("search");
  });

  it("restores Desktops above More", () => {
    const state = buildInitialNavigationState({
      activeView: "desktops",
      selectedTaskId: null
    });

    expect(rootRouteNames(state)).toEqual(["MainTabs", "Desktops"]);
    expect(activeMainTab(state)).toBe("More");
    expect(projectActiveView(state)).toBe("desktops");
  });

  it("keeps More visible instead of inferring detail from its selected task context", () => {
    const state = buildInitialNavigationState({
      activeView: "more",
      selectedTaskId: "task-more-context"
    });

    expect(rootRouteNames(state)).toEqual(["MainTabs"]);
    expect(activeMainTab(state)).toBe("More");
  });
});

describe("projectActiveView", () => {
  it("projects TaskMore to the task route's underlying Activity origin", () => {
    const state = buildInitialNavigationState({
      activeView: "recent",
      selectedTaskId: "task-activity"
    });
    const withTaskMore: InitialState = {
      ...state,
      index: 2,
      routes: [...state.routes, { name: "TaskMore" }]
    };

    expect(projectActiveView(withTaskMore)).toBe("recent");
  });

  it("falls back to Tasks for absent navigation state", () => {
    expect(projectActiveView(undefined)).toBe("tasks");
  });
});
