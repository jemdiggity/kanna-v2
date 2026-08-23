import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T) => styles
  },
  Text: "Text",
  View: "View"
}));

let LanNotificationBanner:
  | typeof import("./LanNotificationBanner").LanNotificationBanner
  | null = null;

beforeAll(async () => {
  LanNotificationBanner = (
    await import("./LanNotificationBanner")
  ).LanNotificationBanner;
});

interface ElementNode {
  props?: {
    children?: ElementNode | ElementNode[] | string | null;
    onPress?: () => void;
    testID?: string;
  };
}

function children(node: ElementNode): Array<ElementNode | string> {
  const value = node.props?.children;
  if (!value) return [];
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value : [value];
}

function text(node: ElementNode | string): string {
  return typeof node === "string"
    ? node
    : children(node).map(text).join("");
}

function find(node: ElementNode | string, testID: string): ElementNode | null {
  if (typeof node === "string") return null;
  if (node.props?.testID === testID) return node;
  for (const child of children(node)) {
    const match = find(child, testID);
    if (match) return match;
  }
  return null;
}

describe("LanNotificationBanner", () => {
  it("renders notification copy with open and dismiss actions", () => {
    if (!LanNotificationBanner) throw new Error("banner was not loaded");
    const onDismiss = vi.fn();
    const onOpen = vi.fn();
    const tree = LanNotificationBanner({
      title: "Agent needs attention",
      body: "Review the latest task result",
      canOpenTask: true,
      onDismiss,
      onOpen
    }) as ElementNode;

    expect(text(tree)).toContain("Agent needs attention");
    expect(text(tree)).toContain("Review the latest task result");
    find(tree, "mobile.lan-notification.open")?.props?.onPress?.();
    find(tree, "mobile.lan-notification.dismiss")?.props?.onPress?.();
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
