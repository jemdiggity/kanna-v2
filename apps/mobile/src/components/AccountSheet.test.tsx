import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importActual) => {
  const actual = await importActual<typeof import("react")>();

  return {
    ...actual,
    useState: <T,>(initialValue: T) => [initialValue, vi.fn()] as const
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

function renderSignedOutSheet(): ElementNode {
  if (!AccountSheet) {
    throw new Error("AccountSheet was not loaded");
  }

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
});
