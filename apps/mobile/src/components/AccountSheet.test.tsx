import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const reactState = vi.hoisted(() => ({
  index: 0,
  values: [] as unknown[]
}));
const openUrl = vi.hoisted(() => vi.fn(() => Promise.resolve()));

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
  Linking: {
    openURL: openUrl
  },
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
let cloudAccessRequestUrl = "";

beforeAll(async () => {
  const module = await import("./AccountSheet");
  AccountSheet = module.AccountSheet;
  cloudAccessRequestUrl = module.CLOUD_ACCESS_REQUEST_URL;
});

beforeEach(() => {
  reactState.index = 0;
  reactState.values = [];
  openUrl.mockClear();
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
    machineCount: 3,
    availableMachineCount: 2,
    quickRepliesReady: true,
    visible: true,
    onClose: vi.fn(),
    onOpenMachines: vi.fn(),
    onOpenQuickReplies: vi.fn(),
    onSignIn: vi.fn(),
    onSignOut: vi.fn()
  }) as ElementNode;
}

function textContent(
  node: ElementNode | ElementNode[] | string | null | undefined
): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textContent).join("");
  return textContent(node.props?.children);
}

describe("AccountSheet", () => {
  it("explains invite-only cloud access and links to request access", () => {
    const tree = renderSignedOutSheet();
    const requestAccessLink = findNodeByAccessibilityLabel(
      tree,
      "Request cloud access"
    );

    expect(textContent(tree)).toContain("Cloud access is invite-only. Request access.");
    expect(requestAccessLink?.props?.accessibilityRole).toBe("link");

    requestAccessLink?.props?.onPress?.();

    expect(openUrl).toHaveBeenCalledWith(cloudAccessRequestUrl);
  });

  it("lifts the sign-in drawer above the iOS keyboard", () => {
    const tree = renderSignedOutSheet();
    const keyboardAvoider = findNodeByType(tree, "KeyboardAvoidingView");

    expect(keyboardAvoider?.props?.behavior).toBe("padding");
  });

  it.each([
    { status: "signedOut" as const },
    {
      status: "signedIn" as const,
      user: { uid: "user-1", email: "dev@example.com", displayName: "Dev" }
    }
  ])("keeps Machines reachable while $status", (auth) => {
    if (!AccountSheet) {
      throw new Error("AccountSheet was not loaded");
    }

    reactState.index = 0;
    const tree = AccountSheet({
      auth,
      machineCount: 3,
      availableMachineCount: 2,
      quickRepliesReady: true,
      visible: true,
      onClose: vi.fn(),
      onOpenMachines: vi.fn(),
      onOpenQuickReplies: vi.fn(),
      onSignIn: vi.fn(),
      onSignOut: vi.fn()
    }) as ElementNode;

    expect(findNodeByTestId(tree, "mobile.account-machines")).not.toBeNull();
    expect(textContent(tree)).toContain("3 machines · 2 available");
    expect(findNodeByTestId(tree, "mobile.account-connection-status")).toBeNull();
  });

  it("opens global quick reply settings", () => {
    if (!AccountSheet) {
      throw new Error("AccountSheet was not loaded");
    }
    const onOpenQuickReplies = vi.fn();
    reactState.index = 0;
    const tree = AccountSheet({
      auth: { status: "signedOut" },
      machineCount: 0,
      availableMachineCount: 0,
      quickRepliesReady: true,
      visible: true,
      onClose: vi.fn(),
      onOpenMachines: vi.fn(),
      onOpenQuickReplies,
      onSignIn: vi.fn(),
      onSignOut: vi.fn()
    }) as ElementNode;

    const button = findNodeByTestId(tree, "mobile.account-quick-replies");
    expect(button).not.toBeNull();
    (button?.props?.onPress as () => void)();
    expect(onOpenQuickReplies).toHaveBeenCalledOnce();
  });

  it("disables quick reply settings until saved replies are ready", () => {
    if (!AccountSheet) {
      throw new Error("AccountSheet was not loaded");
    }
    reactState.index = 0;
    const tree = AccountSheet({
      auth: { status: "signedOut" },
      machineCount: 0,
      availableMachineCount: 0,
      quickRepliesReady: false,
      visible: true,
      onClose: vi.fn(),
      onOpenMachines: vi.fn(),
      onOpenQuickReplies: vi.fn(),
      onSignIn: vi.fn(),
      onSignOut: vi.fn()
    }) as ElementNode;

    const button = findNodeByTestId(tree, "mobile.account-quick-replies");
    expect(button?.props?.disabled).toBe(true);
    expect(button?.props?.accessibilityState).toEqual({ disabled: true });
    expect(textContent(tree)).toContain("Loading saved replies…");
  });

  it("shows the signed-in account initials beside the identity", () => {
    if (!AccountSheet) {
      throw new Error("AccountSheet was not loaded");
    }

    reactState.index = 0;
    const tree = AccountSheet({
      auth: {
        status: "signedIn",
        user: {
          uid: "user-1",
          email: "jeremy@example.com",
          displayName: "Jeremy Hale"
        }
      },
      machineCount: 1,
      availableMachineCount: 1,
      quickRepliesReady: true,
      visible: true,
      onClose: vi.fn(),
      onOpenMachines: vi.fn(),
      onOpenQuickReplies: vi.fn(),
      onSignIn: vi.fn(),
      onSignOut: vi.fn()
    }) as ElementNode;

    expect(findNodeByAccessibilityLabel(tree, "Account initials JH")).not.toBeNull();
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

  it("hides the password again when the drawer closes", () => {
    let tree = renderSignedOutSheet();
    const showToggle = findNodeByTestId(tree, "mobile.account-toggle-password");
    showToggle?.props?.onPress?.();

    tree = renderSignedOutSheet();
    expect(findNodeByTestId(tree, "mobile.account-password")?.props?.secureTextEntry).toBe(
      false
    );

    const closeButton = findNodeByTestId(tree, "mobile.account-close");
    closeButton?.props?.onPress?.();

    tree = renderSignedOutSheet();
    const passwordInput = findNodeByTestId(tree, "mobile.account-password");
    const toggle = findNodeByTestId(tree, "mobile.account-toggle-password");

    expect(passwordInput?.props?.secureTextEntry).toBe(true);
    expect(toggle?.props?.accessibilityLabel).toBe("Show password");
  });

  it("hides the password again when the user signs out", () => {
    if (!AccountSheet) {
      throw new Error("AccountSheet was not loaded");
    }

    let tree = renderSignedOutSheet();
    const showToggle = findNodeByTestId(tree, "mobile.account-toggle-password");
    showToggle?.props?.onPress?.();

    const onSignOut = vi.fn();
    reactState.index = 0;
    tree = AccountSheet({
      auth: {
        status: "signedIn",
        user: { uid: "user-1", email: "dev@example.com", displayName: "Dev" }
      },
      machineCount: 3,
      availableMachineCount: 2,
      quickRepliesReady: true,
      visible: true,
      onClose: vi.fn(),
      onOpenMachines: vi.fn(),
      onOpenQuickReplies: vi.fn(),
      onSignIn: vi.fn(),
      onSignOut
    }) as ElementNode;

    const signOutButton = findNodeByTestId(tree, "mobile.account-sign-out");
    signOutButton?.props?.onPress?.();

    tree = renderSignedOutSheet();
    const passwordInput = findNodeByTestId(tree, "mobile.account-password");
    const toggle = findNodeByTestId(tree, "mobile.account-toggle-password");

    expect(onSignOut).toHaveBeenCalledTimes(1);
    expect(passwordInput?.props?.secureTextEntry).toBe(true);
    expect(toggle?.props?.accessibilityLabel).toBe("Show password");
  });

  it("requires DELETE before invoking permanent account deletion", async () => {
    if (!AccountSheet) throw new Error("AccountSheet was not loaded");
    const onDeleteAccount = vi.fn(async () => undefined);
    const props = {
      auth: {
        status: "signedIn" as const,
        user: { uid: "user-1", email: "dev@example.com", displayName: "Dev" }
      },
      machineCount: 1,
      availableMachineCount: 1,
      quickRepliesReady: true,
      visible: true,
      onClose: vi.fn(),
      onOpenMachines: vi.fn(),
      onOpenQuickReplies: vi.fn(),
      onSignIn: vi.fn(),
      onSignOut: vi.fn(),
      onDeleteAccount
    };

    reactState.index = 0;
    let tree = AccountSheet(props) as ElementNode;
    findNodeByTestId(tree, "mobile.account-delete")?.props?.onPress?.();

    reactState.index = 0;
    tree = AccountSheet(props) as ElementNode;
    expect(textContent(tree)).toContain("subscription");
    expect(textContent(tree)).toContain("cloud data");
    expect(textContent(tree)).toContain("cloud desktop pairings");
    expect(findNodeByTestId(tree, "mobile.account-delete-confirm")?.props?.disabled).toBe(true);

    findNodeByTestId(tree, "mobile.account-delete-input")?.props?.onChangeText?.("DELETE");
    reactState.index = 0;
    tree = AccountSheet(props) as ElementNode;
    const confirm = findNodeByTestId(tree, "mobile.account-delete-confirm");
    expect(confirm?.props?.disabled).toBe(false);
    await confirm?.props?.onPress?.();
    expect(onDeleteAccount).toHaveBeenCalledOnce();
  });
});
