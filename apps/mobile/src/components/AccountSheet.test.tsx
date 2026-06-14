import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const reactState = vi.hoisted(() => ({
  index: 0,
  values: [] as unknown[]
}));

vi.mock("react", async (importActual) => {
  const actual = await importActual<typeof import("react")>();

  return {
    ...actual,
    useState: <T,>(initialValue: T) => {
      const stateIndex = reactState.index;
      reactState.index += 1;
      if (reactState.values.length <= stateIndex) {
        reactState.values[stateIndex] = initialValue;
      }

      return [
        reactState.values[stateIndex] as T,
        (nextValue: T | ((currentValue: T) => T)) => {
          const currentValue = reactState.values[stateIndex] as T;
          reactState.values[stateIndex] =
            typeof nextValue === "function"
              ? (nextValue as (value: T) => T)(currentValue)
              : nextValue;
        }
      ] as const;
    }
  };
});

vi.mock("react-native", () => ({
  KeyboardAvoidingView: "KeyboardAvoidingView",
  Modal: "Modal",
  Platform: {
    OS: "ios"
  },
  Pressable: "Pressable",
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T) => styles
  },
  Text: "Text",
  TextInput: "TextInput",
  View: "View"
}));

let AccountSheet: typeof import("./AccountSheet").AccountSheet | null = null;
let getConnectionStatusPresentation:
  | typeof import("./AccountSheet").getConnectionStatusPresentation
  | null = null;

beforeAll(async () => {
  const module = await import("./AccountSheet");
  AccountSheet = module.AccountSheet;
  getConnectionStatusPresentation = module.getConnectionStatusPresentation;
});

beforeEach(() => {
  reactState.index = 0;
  reactState.values = [];
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

function findNodeByType(node: ElementNode, type: string): ElementNode | null {
  if (node.type === type) {
    return node;
  }

  for (const child of flattenChildren(node.props?.children)) {
    const match = findNodeByType(child, type);
    if (match) {
      return match;
    }
  }

  return null;
}

function findNodeByTestId(node: ElementNode, testID: string): ElementNode | null {
  if (node.props?.testID === testID) {
    return node;
  }

  for (const child of flattenChildren(node.props?.children)) {
    const match = findNodeByTestId(child, testID);
    if (match) {
      return match;
    }
  }

  return null;
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

function renderSignedOutSheet(): ElementNode {
  if (!AccountSheet) {
    throw new Error("AccountSheet was not loaded");
  }

  reactState.index = 0;
  return AccountSheet({
    auth: { status: "signedOut" },
    connectionState: "idle",
    desktopName: null,
    errorMessage: null,
    pairingCode: null,
    visible: true,
    forceCloudEnabled: false,
    showDevForceCloudToggle: false,
    onClose: vi.fn(),
    onConnectLocal: vi.fn(),
    onForceCloudChange: vi.fn(),
    onSignIn: vi.fn(),
    onSignOut: vi.fn()
  }) as ElementNode;
}

function connectionText(
  ...input: Parameters<NonNullable<typeof getConnectionStatusPresentation>>
): string {
  if (!getConnectionStatusPresentation) {
    throw new Error("AccountSheet was not loaded");
  }

  const presentation = getConnectionStatusPresentation(...input);

  return `${presentation.title} ${presentation.detail}`;
}

function textContent(
  node: ElementNode | ElementNode[] | string | null | undefined
): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textContent).join("");
  return textContent(node.props?.children);
}

describe("getConnectionStatusPresentation", () => {
  it("shows disconnected task state as profile drawer connection status", () => {
    expect(connectionText("idle", null, null, null)).toContain("Not connected");
    expect(connectionText("error", null, null, "LAN request failed")).toContain(
      "LAN request failed"
    );
  });

  it("shows the connected desktop name", () => {
    expect(connectionText("connected", "Kanna Cloud", null, null)).toContain(
      "Kanna Cloud"
    );
  });
});

describe("AccountSheet", () => {
  it("lifts the sign-in drawer above the iOS keyboard", () => {
    const tree = renderSignedOutSheet();
    const keyboardAvoider = findNodeByType(tree, "KeyboardAvoidingView");

    expect(keyboardAvoider?.props?.behavior).toBe("padding");
  });

  it("renders the force-cloud toggle only when the dev-only flag is enabled", () => {
    if (!AccountSheet) {
      throw new Error("AccountSheet was not loaded");
    }

    const hiddenTree = renderSignedOutSheet();
    expect(findNodeByTestId(hiddenTree, "mobile.account-force-cloud")).toBeNull();

    const visibleTree = AccountSheet({
      auth: { status: "signedOut" },
      connectionState: "idle",
      desktopName: null,
      errorMessage: null,
      pairingCode: null,
      visible: true,
      forceCloudEnabled: true,
      showDevForceCloudToggle: true,
      onClose: vi.fn(),
      onConnectLocal: vi.fn(),
      onForceCloudChange: vi.fn(),
      onSignIn: vi.fn(),
      onSignOut: vi.fn()
    }) as ElementNode;

    expect(findNodeByTestId(visibleTree, "mobile.account-force-cloud")).not.toBeNull();
  });

  it("starts with a hidden password and renders a show-password control", () => {
    const tree = renderSignedOutSheet();
    const passwordInput = findNodeByTestId(tree, "mobile.account-password");
    const toggle = findNodeByTestId(tree, "mobile.account-toggle-password");

    expect(passwordInput?.props?.secureTextEntry).toBe(true);
    expect(toggle?.props?.accessibilityLabel).toBe("Show password");
    expect(textContent(toggle)).toBe("Show");
  });

  it("reveals and hides the password when the visibility control is pressed", () => {
    let tree = renderSignedOutSheet();
    let passwordInput = findNodeByTestId(tree, "mobile.account-password");
    const showToggle = findNodeByTestId(tree, "mobile.account-toggle-password");

    expect(passwordInput?.props?.secureTextEntry).toBe(true);
    showToggle?.props?.onPress?.();

    tree = renderSignedOutSheet();
    passwordInput = findNodeByTestId(tree, "mobile.account-password");
    const hideToggle = findNodeByTestId(tree, "mobile.account-toggle-password");

    expect(passwordInput?.props?.secureTextEntry).toBe(false);
    expect(hideToggle?.props?.accessibilityLabel).toBe("Hide password");
    expect(textContent(hideToggle)).toBe("Hide");

    hideToggle?.props?.onPress?.();

    tree = renderSignedOutSheet();
    passwordInput = findNodeByTestId(tree, "mobile.account-password");
    const finalToggle = findNodeByTestId(tree, "mobile.account-toggle-password");

    expect(passwordInput?.props?.secureTextEntry).toBe(true);
    expect(finalToggle?.props?.accessibilityLabel).toBe("Show password");
    expect(textContent(finalToggle)).toBe("Show");
  });
});
