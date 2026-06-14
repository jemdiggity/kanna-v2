import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthState } from "../state/sessionStore";

vi.mock("react", async (importActual) => {
  const actual = await importActual<typeof import("react")>();

  return {
    ...actual,
    useState: <T,>(initialValue: T) => [initialValue, vi.fn()] as const
  };
});

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T) => styles
  },
  Text: "Text",
  TextInput: "TextInput",
  View: "View"
}));

let getConnectionAuthSummary:
  | typeof import("./ConnectionScreen").getConnectionAuthSummary
  | null = null;
let ConnectionScreen: typeof import("./ConnectionScreen").ConnectionScreen | null = null;

beforeAll(async () => {
  const module = await import("./ConnectionScreen");
  ConnectionScreen = module.ConnectionScreen;
  getConnectionAuthSummary = module.getConnectionAuthSummary;
});

interface ElementNode {
  type: unknown;
  props?: {
    children?: ElementNode | ElementNode[];
    [key: string]: unknown;
  };
}

function flattenChildren(
  children: ElementNode | ElementNode[] | string | null | undefined
): ElementNode[] {
  if (!children) {
    return [];
  }

  const flattened = Array.isArray(children) ? children : [children];

  return flattened.filter(
    (child): child is ElementNode => Boolean(child) && typeof child !== "string"
  );
}

function findNodeByAccessibilityLabel(
  node: ElementNode,
  accessibilityLabel: string
): ElementNode | null {
  if (node.props?.accessibilityLabel === accessibilityLabel) {
    return node;
  }

  for (const child of flattenChildren(node.props?.children)) {
    const match = findNodeByAccessibilityLabel(child, accessibilityLabel);
    if (match) {
      return match;
    }
  }

  return null;
}

function findPasswordInput(node: ElementNode): ElementNode | null {
  if (node.type === "TextInput" && node.props?.placeholder === "Password") {
    return node;
  }

  for (const child of flattenChildren(node.props?.children)) {
    const match = findPasswordInput(child);
    if (match) {
      return match;
    }
  }

  return null;
}

function renderAuthText(auth: AuthState): string {
  if (!getConnectionAuthSummary) {
    throw new Error("ConnectionScreen was not loaded");
  }

  const summary = getConnectionAuthSummary(auth);

  return `${summary.title} ${summary.detail}`;
}

describe("ConnectionScreen", () => {
  it("shows signed-out auth state", () => {
    expect(renderAuthText({ status: "signedOut" })).toContain("Signed out");
  });

  it("shows signed-in auth state with the current user email", () => {
    expect(
      renderAuthText({
        status: "signedIn",
        user: {
          uid: "user-1",
          email: "dev@kanna.test",
          displayName: null
        }
      })
    ).toContain("dev@kanna.test");
  });

  it("starts with a hidden password and renders a show-password control", () => {
    if (!ConnectionScreen) {
      throw new Error("ConnectionScreen was not loaded");
    }

    const tree = ConnectionScreen({
      auth: { status: "signedOut" },
      connectionState: "idle",
      desktopName: null,
      errorMessage: null,
      pairingCode: null,
      onConnectLocal: vi.fn(),
      onSignIn: vi.fn(),
      onSignOut: vi.fn()
    }) as ElementNode;

    expect(findPasswordInput(tree)?.props?.secureTextEntry).toBe(true);
    expect(findNodeByAccessibilityLabel(tree, "Show password")).not.toBeNull();
  });
});
