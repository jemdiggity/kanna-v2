import React from "react";
import {
  act,
  create,
  type ReactTestRenderer
} from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { FloatingToolbar } from "./FloatingToolbar";

vi.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
vi.mock("react-native", () => ({
  Pressable: "Pressable",
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T) => styles
  },
  Text: "Text",
  View: "View"
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

describe("FloatingToolbar", () => {
  it("uses opaque dark surfaces for secondary floating chrome", () => {
    let renderer: ReactTestRenderer | undefined;
    act(() => {
      renderer = create(
        <FloatingToolbar
          activeTab="tasks"
          tabs={[
            { name: "tasks", label: "Tasks", icon: "home-outline" },
            { name: "recent", label: "Activity", icon: "notifications-outline" },
            { name: "more", label: "More", icon: "ellipsis-horizontal" }
          ]}
          utilityActions={[
            { name: "search", label: "Search", icon: "search-outline" },
            { name: "create", label: "Add task", icon: "add" }
          ]}
          onSelectTab={vi.fn()}
          onSelectUtilityAction={vi.fn()}
        />
      );
    });

    const searchButton = renderer!.root.find(
      (node) =>
        node.type === "Pressable" && node.props.accessibilityLabel === "Search"
    );
    const navigationBar = renderer!.root.findAllByType("View").find(
      (node) => node.findAllByType("Pressable", { deep: false }).length === 3
    );

    expect(flattenStyle(searchButton.props.style).backgroundColor).toBe(
      "#080F1B"
    );
    expect(flattenStyle(navigationBar?.props.style).backgroundColor).toBe(
      "#080F1B"
    );

    act(() => renderer!.unmount());
  });
});
