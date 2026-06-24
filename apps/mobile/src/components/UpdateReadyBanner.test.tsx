import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T) => styles
  },
  Text: "Text",
  View: "View"
}));

let UpdateReadyBanner:
  | typeof import("./UpdateReadyBanner").UpdateReadyBanner
  | null = null;

beforeAll(async () => {
  UpdateReadyBanner = (await import("./UpdateReadyBanner")).UpdateReadyBanner;
});

interface ElementNode {
  type: unknown;
  props?: {
    children?: ElementNode | ElementNode[] | string | null;
    onPress?: () => void;
    testID?: string;
    [key: string]: unknown;
  };
}

function flattenChildren(
  children: ElementNode | ElementNode[] | string | null | undefined
): Array<ElementNode | string> {
  if (!children) return [];
  if (typeof children === "string") return [children];
  return (Array.isArray(children) ? children : [children]).filter(Boolean);
}

function textContent(node: ElementNode | string | null | undefined): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  return flattenChildren(node.props?.children).map(textContent).join("");
}

function findByTestId(
  node: ElementNode | string,
  testID: string
): ElementNode | null {
  if (typeof node === "string") return null;
  if (node.props?.testID === testID) return node;

  for (const child of flattenChildren(node.props?.children)) {
    const result = findByTestId(child, testID);
    if (result) return result;
  }

  return null;
}

describe("UpdateReadyBanner", () => {
  it("renders restart and dismiss actions for a downloaded update", () => {
    if (!UpdateReadyBanner) throw new Error("UpdateReadyBanner was not loaded");

    const onDismiss = vi.fn();
    const onRestart = vi.fn();
    const tree = UpdateReadyBanner({ onDismiss, onRestart }) as ElementNode;

    expect(textContent(tree)).toContain("Update ready");
    expect(textContent(tree)).toContain("Restart to apply");

    findByTestId(tree, "mobile.update-ready.restart")?.props?.onPress?.();
    findByTestId(tree, "mobile.update-ready.dismiss")?.props?.onPress?.();

    expect(onRestart).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
