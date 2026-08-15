import React from "react";
import {
  act,
  create,
  type ReactTestRenderer
} from "react-test-renderer";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@expo/vector-icons", () => ({
  Ionicons: "Ionicons"
}));

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T) => styles
  },
  Text: "Text",
  View: "View"
}));

function flattenStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return style.reduce<Record<string, unknown>>(
      (result, item) => ({ ...result, ...flattenStyle(item) }),
      {}
    );
  }

  return style && typeof style === "object"
    ? (style as Record<string, unknown>)
    : {};
}

let FloatingToolbar:
  | typeof import("./FloatingToolbar").FloatingToolbar
  | null = null;
let rendered: ReactTestRenderer | null = null;

beforeAll(async () => {
  FloatingToolbar = (await import("./FloatingToolbar")).FloatingToolbar;
});

afterEach(async () => {
  if (rendered) {
    await act(async () => rendered?.unmount());
    rendered = null;
  }
});

describe("FloatingToolbar", () => {
  const createNavigatorProps = (activeIndex = 0) => ({
    state: {
      index: activeIndex,
      key: "tabs",
      routeNames: ["Tasks", "Activity", "More"],
      routes: [
        { key: "tasks", name: "Tasks", params: undefined },
        { key: "activity", name: "Activity", params: undefined },
        { key: "more", name: "More", params: undefined }
      ],
      stale: false,
      type: "tab",
      history: [],
      preloadedRouteKeys: []
    },
    descriptors: {},
    insets: { top: 0, right: 0, bottom: 0, left: 0 },
    navigation: {
      emit: vi.fn(() => ({ defaultPrevented: false })),
      navigate: vi.fn()
    }
  });

  it("derives Activity from navigator state and navigates through the tab router", async () => {
    if (!FloatingToolbar) throw new Error("FloatingToolbar was not loaded");
    const navigatorProps = createNavigatorProps(1);

    await act(async () => {
      rendered = create(
        React.createElement(FloatingToolbar, {
          ...navigatorProps,
          onSelectUtilityAction: vi.fn()
        } as never)
      );
    });

    const activity = rendered.root.find(
      (node) => node.type === "Pressable" && node.props.testID?.endsWith("recent")
    );
    const tasks = rendered.root.find(
      (node) => node.type === "Pressable" && node.props.testID?.endsWith("tasks")
    );

    expect(flattenStyle(activity.props.style).backgroundColor).toBe("#E8F1FF");
    expect(activity.props).toMatchObject({
      accessibilityRole: "tab",
      accessibilityState: { selected: true }
    });
    expect(tasks.props).toMatchObject({
      accessibilityRole: "tab",
      accessibilityState: { selected: false }
    });
    await act(async () => tasks.props.onPress());
    expect(navigatorProps.navigation.emit).toHaveBeenCalledWith({
      type: "tabPress",
      target: "tasks",
      canPreventDefault: true
    });
    expect(navigatorProps.navigation.navigate).toHaveBeenCalledWith(
      "Tasks",
      undefined
    );
  });

  it("shows the unread Activity count from the shared notification projection", async () => {
    if (!FloatingToolbar) throw new Error("FloatingToolbar was not loaded");
    const navigatorProps = createNavigatorProps();

    await act(async () => {
      rendered = create(
        React.createElement(FloatingToolbar, {
          ...navigatorProps,
          activityCount: 3,
          onSelectUtilityAction: vi.fn()
        } as never)
      );
    });

    const activity = rendered.root.find(
      (node) => node.props.testID?.endsWith("recent")
    );
    const badge = rendered.root.findByProps({
      testID: "mobile.activity-badge"
    });
    expect(activity.props.accessibilityLabel).toBe("Activity, 3 unread");
    expect(badge.findByType("Text").props.children).toBe(3);
  });

  it("emits the active tab press without recreating navigation state", async () => {
    if (!FloatingToolbar) throw new Error("FloatingToolbar was not loaded");
    const navigatorProps = createNavigatorProps(0);

    await act(async () => {
      rendered = create(
        React.createElement(FloatingToolbar, {
          ...navigatorProps,
          onSelectUtilityAction: vi.fn()
        } as never)
      );
    });

    const tasks = rendered.root.find(
      (node) => node.props.testID?.endsWith("tasks")
    );
    await act(async () => tasks.props.onPress());

    expect(navigatorProps.navigation.emit).toHaveBeenCalledWith({
      type: "tabPress",
      target: "tasks",
      canPreventDefault: true
    });
    expect(navigatorProps.navigation.navigate).not.toHaveBeenCalled();
  });

  it("uses opaque dark surfaces for secondary floating chrome", async () => {
    if (!FloatingToolbar) throw new Error("FloatingToolbar was not loaded");

    await act(async () => {
      rendered = create(
        React.createElement(FloatingToolbar, {
          ...createNavigatorProps(),
          onSelectUtilityAction: vi.fn()
        } as never)
      );
    });

    const searchButton = rendered.root.find(
      (node) =>
        node.type === "Pressable" && node.props.accessibilityLabel === "Search"
    );
    const navigationBar = rendered.root.findAllByType("View").find(
      (node) => node.findAllByType("Pressable", { deep: false }).length === 3
    );

    expect(flattenStyle(searchButton.props.style).backgroundColor).toBe(
      "#080F1B"
    );
    expect(searchButton.props.accessibilityRole).toBe("button");
    expect(flattenStyle(navigationBar?.props.style).backgroundColor).toBe(
      "#080F1B"
    );
  });

  it("visibly responds while the Add task button is pressed", async () => {
    if (!FloatingToolbar) throw new Error("FloatingToolbar was not loaded");

    await act(async () => {
      rendered = create(
        React.createElement(FloatingToolbar, {
          ...createNavigatorProps(),
          onSelectUtilityAction: vi.fn()
        } as never)
      );
    });

    const addTaskButton = rendered.root.find(
      (node) =>
        node.type === "Pressable" &&
        node.props.accessibilityLabel === "Add task"
    );
    const resolveStyle = addTaskButton.props.style;

    expect(addTaskButton.props.accessibilityRole).toBe("button");
    expect(resolveStyle).toBeTypeOf("function");
    expect(resolveStyle({ pressed: true })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          backgroundColor: "#C8D9F0",
          opacity: 0.84,
          transform: [{ scale: 0.94 }]
        })
      ])
    );
    expect(resolveStyle({ pressed: false })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ backgroundColor: "#E8F1FF" })
      ])
    );
    expect(resolveStyle({ pressed: true })).not.toEqual(
      resolveStyle({ pressed: false })
    );
  });
});
