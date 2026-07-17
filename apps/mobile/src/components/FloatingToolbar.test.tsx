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
  it("uses opaque dark surfaces for secondary floating chrome", async () => {
    if (!FloatingToolbar) throw new Error("FloatingToolbar was not loaded");

    await act(async () => {
      rendered = create(
        React.createElement(FloatingToolbar, {
          activeTab: "tasks",
          tabs: [
            { name: "tasks", label: "Tasks", icon: "home-outline" },
            { name: "recent", label: "Activity", icon: "notifications-outline" },
            { name: "more", label: "More", icon: "ellipsis-horizontal" }
          ],
          utilityActions: [
            { name: "search", label: "Search", icon: "search-outline" },
            { name: "create", label: "Add task", icon: "add" }
          ],
          onSelectTab: vi.fn(),
          onSelectUtilityAction: vi.fn()
        })
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
    expect(flattenStyle(navigationBar?.props.style).backgroundColor).toBe(
      "#080F1B"
    );
  });

  it("visibly responds while the Add task button is pressed", async () => {
    if (!FloatingToolbar) throw new Error("FloatingToolbar was not loaded");

    await act(async () => {
      rendered = create(
        React.createElement(FloatingToolbar, {
          activeTab: "tasks",
          tabs: [
            { name: "tasks", label: "Tasks", icon: "home-outline" },
            { name: "more", label: "More", icon: "ellipsis-horizontal" }
          ],
          utilityActions: [
            { name: "search", label: "Search", icon: "search-outline" },
            { name: "create", label: "Add task", icon: "add" }
          ],
          onSelectTab: vi.fn(),
          onSelectUtilityAction: vi.fn()
        })
      );
    });

    const addTaskButton = rendered.root.find(
      (node) =>
        node.type === "Pressable" &&
        node.props.accessibilityLabel === "Add task"
    );
    const resolveStyle = addTaskButton.props.style;

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
