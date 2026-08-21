import { beforeAll, describe, expect, it, vi } from "vitest";
import { AGENT_PROVIDERS } from "@kanna/agent-protocol";

vi.mock("react-native", () => ({
  KeyboardAvoidingView: "KeyboardAvoidingView",
  Modal: "Modal",
  Platform: {
    OS: "ios"
  },
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  StyleSheet: {
    absoluteFill: "absoluteFill",
    create: <T extends Record<string, unknown>>(styles: T) => styles
  },
  Text: "Text",
  TextInput: "TextInput",
  View: "View"
}));

let CreateTaskComposer:
  | typeof import("./CreateTaskComposer").CreateTaskComposer
  | null = null;

beforeAll(async () => {
  CreateTaskComposer = (await import("./CreateTaskComposer")).CreateTaskComposer;
});

interface ElementNode {
  type: unknown;
  props?: {
    children?: ElementNode | ElementNode[] | string | null;
    [key: string]: unknown;
  };
}

function flattenChildren(
  children: ElementNode | ElementNode[] | string | null | undefined
): ElementNode[] {
  if (!children || typeof children === "string") return [];
  return (Array.isArray(children) ? children : [children]).filter(Boolean);
}

function findNodeByType(node: ElementNode, type: string): ElementNode | null {
  if (node.type === type) return node;

  for (const child of flattenChildren(node.props?.children)) {
    const match = findNodeByType(child, type);
    if (match) return match;
  }

  return null;
}

function textContent(
  node: ElementNode | ElementNode[] | string | null | undefined
): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textContent).join("");
  return textContent(node.props?.children);
}

function findNodeByText(node: ElementNode, text: string): ElementNode | null {
  if (textContent(node) === text) return node;

  for (const child of flattenChildren(node.props?.children)) {
    const match = findNodeByText(child, text);
    if (match) return match;
  }

  return null;
}

function findNodeByTestId(node: ElementNode, testID: string): ElementNode | null {
  if (node.props?.testID === testID) return node;

  for (const child of flattenChildren(node.props?.children)) {
    const match = findNodeByTestId(child, testID);
    if (match) return match;
  }

  return null;
}

function renderComposer(
  overrides: Partial<{
    prompt: string;
    repos: Parameters<NonNullable<typeof CreateTaskComposer>>[0]["repos"];
    desktops: Parameters<NonNullable<typeof CreateTaskComposer>>[0]["desktops"];
    selectedRepoId: string | null;
    selectedDesktopId: string | null;
    selectedAgentProvider: string | null;
    isOptionsExpanded: boolean;
    errorMessage: string | null;
    checkoutOffer: Parameters<NonNullable<typeof CreateTaskComposer>>[0]["checkoutOffer"];
    onClose: () => void;
    onSelectDesktop: (desktopId: string) => void;
    onSelectAgentProvider: (provider: string) => void;
    onToggleOptions: () => void;
    onSubmit: () => void;
    onCheckout: () => void;
  }> = {}
): ElementNode {
  if (!CreateTaskComposer) {
    throw new Error("CreateTaskComposer was not loaded");
  }

  return CreateTaskComposer({
    isOpen: true,
    prompt: overrides.prompt ?? "Ship mobile shell",
    repos: overrides.repos ?? [{ id: "repo-1", name: "Repo One" }],
    desktops: overrides.desktops ?? [
      { id: "desktop-1", name: "Studio Mac", online: true, mode: "lan" },
      { id: "desktop-2", name: "Laptop", online: false, mode: "remote" }
    ],
    selectedRepoId:
      overrides.selectedRepoId === undefined ? "repo-1" : overrides.selectedRepoId,
    selectedDesktopId:
      overrides.selectedDesktopId === undefined ? "desktop-1" : overrides.selectedDesktopId,
    selectedAgentProvider:
      overrides.selectedAgentProvider === undefined
        ? "claude"
        : overrides.selectedAgentProvider,
    isOptionsExpanded: overrides.isOptionsExpanded ?? false,
    errorMessage:
      overrides.errorMessage === undefined ? null : overrides.errorMessage,
    checkoutOffer: overrides.checkoutOffer ?? null,
    onChangePrompt: vi.fn(),
    onClose: overrides.onClose ?? vi.fn(),
    onSelectDesktop: overrides.onSelectDesktop ?? vi.fn(),
    onSelectAgentProvider: overrides.onSelectAgentProvider ?? vi.fn(),
    onToggleOptions: overrides.onToggleOptions ?? vi.fn(),
    onSubmit: overrides.onSubmit ?? vi.fn(),
    onCheckout: overrides.onCheckout ?? vi.fn()
  } as Parameters<NonNullable<typeof CreateTaskComposer>>[0] & {
    selectedAgentProvider: string | null;
    errorMessage: string | null;
    onSelectDesktop(desktopId: string): void;
    onSelectAgentProvider(provider: string): void;
    onToggleOptions(): void;
  }) as ElementNode;
}

describe("CreateTaskComposer", () => {
  it("lifts the new task drawer above the iOS keyboard", () => {
    const tree = renderComposer();
    const keyboardAvoider = findNodeByType(tree, "KeyboardAvoidingView");

    expect(keyboardAvoider?.props?.behavior).toBe("padding");
  });

  it("keeps the create action above the dismiss backdrop", () => {
    const tree = renderComposer();
    const keyboardAvoider = findNodeByType(tree, "KeyboardAvoidingView");
    const children = flattenChildren(keyboardAvoider?.props?.children);
    const backdrop = children[0];
    const sheet = children[1];
    const createLabel = findNodeByText(sheet, "Create");

    expect(backdrop?.type).toBe("Pressable");
    expect(createLabel).not.toBeNull();
    expect(sheet?.props?.style).toEqual(
      expect.objectContaining({
        zIndex: expect.any(Number)
      })
    );
  });

  it("keeps the sheet scrollable when the keyboard shrinks the visible area", () => {
    const tree = renderComposer({ isOptionsExpanded: true });
    const keyboardAvoider = findNodeByType(tree, "KeyboardAvoidingView");
    const sheet = flattenChildren(keyboardAvoider?.props?.children)[1];
    const sheetScroll = findNodeByTestId(tree, "mobile.create-task.sheet-scroll");

    expect(sheet?.type).toBe("View");
    expect(sheet?.props?.style).toEqual(
      expect.objectContaining({
        maxHeight: "100%"
      })
    );
    expect(sheetScroll?.type).toBe("ScrollView");
    expect(sheetScroll?.props?.keyboardShouldPersistTaps).toBe("handled");
    expect(findNodeByText(sheetScroll as ElementNode, "New task")).not.toBeNull();
    expect(findNodeByText(sheetScroll as ElementNode, "Create")).not.toBeNull();
    expect(
      findNodeByTestId(sheetScroll as ElementNode, "mobile.create-task.prompt")
    ).not.toBeNull();
  });

  it("shows a compact selected repo and options summary by default", () => {
    const onToggleOptions = vi.fn();
    const tree = renderComposer({ onToggleOptions });
    const optionsToggle = findNodeByTestId(tree, "mobile.create-task.options-toggle");

    expect(findNodeByText(tree, "Repo One")).not.toBeNull();
    expect(findNodeByText(tree, "Studio Mac (online) · Claude")).not.toBeNull();
    expect(findNodeByText(tree, "Copilot")).toBeNull();
    expect(optionsToggle?.props).toMatchObject({
      accessibilityRole: "button",
      accessibilityState: { expanded: false }
    });

    (optionsToggle?.props?.onPress as (() => void) | undefined)?.();

    expect(onToggleOptions).toHaveBeenCalledTimes(1);
  });

  it("renders machine and agent choices and selects tapped options", () => {
    const onSelectDesktop = vi.fn();
    const onSelectAgentProvider = vi.fn();
    const tree = renderComposer({
      isOptionsExpanded: true,
      onSelectDesktop,
      onSelectAgentProvider
    });
    const laptopOption = findNodeByTestId(tree, "mobile.create-task.machine.desktop-2");
    const copilotOption = findNodeByText(tree, "Copilot");

    expect(findNodeByText(tree, "Studio Mac")).not.toBeNull();
    expect(findNodeByText(tree, "Online")).not.toBeNull();
    expect(findNodeByText(tree, "Claude")).not.toBeNull();
    expect(findNodeByText(tree, "Codex")).not.toBeNull();
    expect(findNodeByText(tree, "OpenCode")).not.toBeNull();
    expect(findNodeByText(tree, "Antigravity")).not.toBeNull();
    expect(findNodeByText(tree, "Laptop")).not.toBeNull();
    expect(findNodeByText(tree, "Offline")).not.toBeNull();
    expect(copilotOption).not.toBeNull();
    expect(laptopOption?.props).toMatchObject({
      accessibilityRole: "button",
      accessibilityState: { selected: false }
    });
    expect(copilotOption?.props).toMatchObject({
      accessibilityRole: "button",
      accessibilityState: { selected: false }
    });

    (laptopOption?.props?.onPress as (() => void) | undefined)?.();
    (copilotOption?.props?.onPress as (() => void) | undefined)?.();

    expect(onSelectDesktop).toHaveBeenCalledWith("desktop-2");
    expect(onSelectAgentProvider).toHaveBeenCalledWith("copilot");
    expect(AGENT_PROVIDERS).toHaveLength(5);
  });

  it("offers only the agent providers the selected machine reports", () => {
    const tree = renderComposer({
      isOptionsExpanded: true,
      selectedAgentProvider: "opencode",
      desktops: [
        {
          id: "desktop-1",
          name: "Studio Mac",
          online: true,
          mode: "lan",
          agentProviders: ["opencode"]
        }
      ]
    });

    expect(
      findNodeByTestId(tree, "mobile.create-task.agent.opencode")
    ).not.toBeNull();
    for (const missing of ["claude", "copilot", "codex", "antigravity"]) {
      expect(
        findNodeByTestId(tree, `mobile.create-task.agent.${missing}`)
      ).toBeNull();
    }
    expect(findNodeByText(tree, "Studio Mac (online) · OpenCode")).not.toBeNull();
  });

  it("still offers every provider for a machine that reports no inventory", () => {
    const tree = renderComposer({
      isOptionsExpanded: true,
      desktops: [{ id: "desktop-1", name: "Studio Mac", online: true, mode: "lan" }]
    });

    for (const provider of AGENT_PROVIDERS) {
      expect(
        findNodeByTestId(tree, `mobile.create-task.agent.${provider}`)
      ).not.toBeNull();
    }
  });

  it("blocks creation on a machine that reports no agent CLI at all", () => {
    const onSubmit = vi.fn();
    const tree = renderComposer({
      isOptionsExpanded: true,
      selectedAgentProvider: null,
      onSubmit,
      desktops: [
        {
          id: "desktop-1",
          name: "Studio Mac",
          online: true,
          mode: "lan",
          agentProviders: []
        }
      ]
    });
    const submit = findNodeByTestId(tree, "mobile.create-task.submit");

    expect(submit?.props?.disabled).toBe(true);
    expect(submit?.props?.onPress).toBeUndefined();
    for (const provider of AGENT_PROVIDERS) {
      expect(
        findNodeByTestId(tree, `mobile.create-task.agent.${provider}`)
      ).toBeNull();
    }
    expect(
      findNodeByText(
        tree,
        "Studio Mac has no agent CLI installed. Install one of Claude, Copilot, Codex, OpenCode, Antigravity on that machine to create tasks there."
      )
    ).not.toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("offers a target machine where the selected canonical repo is not registered", () => {
    const tree = renderComposer({
      isOptionsExpanded: true,
      repos: [
        {
          id: "git:hash-kanji",
          name: "kanji-kongbu",
          remoteUrlHash: "hash-kanji",
          registeredDesktopIds: ["desktop-1", "desktop-2"]
        }
      ],
      desktops: [
        { id: "desktop-1", name: "MacBook Pro", online: true, mode: "lan" },
        { id: "desktop-2", name: "Mac mini", online: true, mode: "remote" },
        { id: "desktop-3", name: "Mac Studio", online: true, mode: "remote" }
      ],
      selectedRepoId: "git:hash-kanji",
      selectedDesktopId: "desktop-3"
    });

    expect(findNodeByText(tree, "MacBook Pro")).not.toBeNull();
    expect(findNodeByText(tree, "Mac mini")).not.toBeNull();
    expect(findNodeByText(tree, "Mac Studio")).not.toBeNull();
    expect(findNodeByText(tree, "Mac Studio (online) · Claude")).not.toBeNull();
    expect(findNodeByTestId(tree, "mobile.create-task.submit")?.props?.disabled).toBe(
      false
    );
  });

  it("disables ordinary creation while checkout is offered", () => {
    const onSubmit = vi.fn();
    const onCheckout = vi.fn();
    const tree = renderComposer({
      onSubmit,
      onCheckout,
      checkoutOffer: {
        action: "create-task",
        status: "offered",
        repoId: "repo-1",
        repoName: "Repo One",
        desktopId: "desktop-1",
        desktopName: "Studio Mac"
      }
    });
    const submit = findNodeByTestId(tree, "mobile.create-task.submit");
    const checkout = findNodeByTestId(tree, "mobile.create-task.checkout");

    expect(submit?.props?.disabled).toBe(true);
    expect(submit?.props?.onPress).toBeUndefined();
    (checkout?.props?.onPress as (() => void) | undefined)?.();
    expect(onCheckout).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("calls submit when the create button is enabled", () => {
    const onSubmit = vi.fn();
    const tree = renderComposer({ onSubmit });
    const createButton = findNodeByText(tree, "Create");

    (createButton?.props?.onPress as (() => void) | undefined)?.();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(createButton?.props?.disabled).toBe(false);
    expect(createButton?.props).toMatchObject({
      accessibilityRole: "button",
      accessibilityState: { disabled: false }
    });
  });

  it("restores a failed valid submission so it can be retried", () => {
    const onSubmit = vi.fn();
    const tree = renderComposer({
      prompt: "Ship mobile shell",
      selectedRepoId: "repo-1",
      selectedDesktopId: "desktop-1",
      selectedAgentProvider: "claude",
      errorMessage: "Desktop unavailable",
      onSubmit
    });
    const promptInput = findNodeByTestId(tree, "mobile.create-task.prompt");
    const inlineError = findNodeByTestId(tree, "mobile.create-task.error");
    const submitButton = findNodeByTestId(tree, "mobile.create-task.submit");

    expect(promptInput?.props?.value).toBe("Ship mobile shell");
    expect(findNodeByText(tree, "Studio Mac (online) · Claude")).not.toBeNull();
    expect(textContent(inlineError)).toBe("Desktop unavailable");
    expect(submitButton).not.toBeNull();
    expect(submitButton?.props?.disabled).toBe(false);

    (submitButton?.props?.onPress as (() => void) | undefined)?.();

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("keeps normal composer dismissal available before submission", () => {
    const onClose = vi.fn();
    const tree = renderComposer({ onClose });
    const modal = findNodeByType(tree, "Modal");
    const keyboardAvoider = findNodeByType(tree, "KeyboardAvoidingView");
    const backdrop = flattenChildren(keyboardAvoider?.props?.children)[0];

    (modal?.props?.onRequestClose as (() => void) | undefined)?.();
    expect(onClose).toHaveBeenCalledTimes(1);

    (backdrop?.props?.onPress as (() => void) | undefined)?.();

    expect(backdrop?.props).toMatchObject({
      accessibilityElementsHidden: true,
      accessible: false,
      importantForAccessibility: "no-hide-descendants"
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("shows composer validation errors next to the create controls", () => {
    const tree = renderComposer({
      errorMessage: "Choose a repo and enter a task prompt first.",
      prompt: ""
    });
    const createButton = findNodeByText(tree, "Create");

    expect(findNodeByText(tree, "Choose a repo and enter a task prompt first.")).not.toBeNull();
    expect(createButton?.props?.disabled).toBe(true);
    expect(createButton?.props?.accessibilityState).toEqual({ disabled: true });
  });

  it("disables create until a machine is selected", () => {
    const tree = renderComposer({
      selectedDesktopId: null,
      isOptionsExpanded: true
    });
    const createButton = findNodeByText(tree, "Create");

    expect(findNodeByText(tree, "Choose machine · Claude")).not.toBeNull();
    expect(findNodeByText(tree, "Choose a machine before creating.")).not.toBeNull();
    expect(createButton?.props?.disabled).toBe(true);
  });

  it("treats a selected machine id that is not in the desktop list as missing", () => {
    const onSubmit = vi.fn();
    const tree = renderComposer({
      selectedDesktopId: "desktop-stale",
      isOptionsExpanded: true,
      onSubmit
    });
    const createButton = findNodeByText(tree, "Create");

    (createButton?.props?.onPress as (() => void) | undefined)?.();

    expect(findNodeByText(tree, "Choose machine · Claude")).not.toBeNull();
    expect(findNodeByText(tree, "Choose a machine before creating.")).not.toBeNull();
    expect(createButton?.props?.disabled).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
