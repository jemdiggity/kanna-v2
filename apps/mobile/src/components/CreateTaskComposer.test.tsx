import { beforeAll, describe, expect, it, vi } from "vitest";
import { AGENT_PROVIDERS } from "@kanna/agent-protocol";
import type { TaskCreationPhase } from "../state/sessionStore";

vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  KeyboardAvoidingView: "KeyboardAvoidingView",
  Modal: "Modal",
  Platform: {
    OS: "ios"
  },
  Pressable: "Pressable",
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
    selectedRepoId: string | null;
    selectedDesktopId: string | null;
    selectedAgentProvider: string;
    isOptionsExpanded: boolean;
    errorMessage: string | null;
    taskCreationPhase: TaskCreationPhase;
    onClose: () => void;
    onContinueInBackground: () => void;
    onRecover: () => void;
    onSelectDesktop: (desktopId: string) => void;
    onSelectAgentProvider: (provider: string) => void;
    onToggleOptions: () => void;
    onSubmit: () => void;
  }> = {}
): ElementNode {
  if (!CreateTaskComposer) {
    throw new Error("CreateTaskComposer was not loaded");
  }

  return CreateTaskComposer({
    isOpen: true,
    prompt: overrides.prompt ?? "Ship mobile shell",
    repos: [{ id: "repo-1", name: "Repo One" }],
    desktops: [
      { id: "desktop-1", name: "Studio Mac", online: true, mode: "lan" },
      { id: "desktop-2", name: "Laptop", online: false, mode: "remote" }
    ],
    selectedRepoId:
      overrides.selectedRepoId === undefined ? "repo-1" : overrides.selectedRepoId,
    selectedDesktopId:
      overrides.selectedDesktopId === undefined ? "desktop-1" : overrides.selectedDesktopId,
    selectedAgentProvider: overrides.selectedAgentProvider ?? "claude",
    isOptionsExpanded: overrides.isOptionsExpanded ?? false,
    errorMessage:
      overrides.errorMessage === undefined ? null : overrides.errorMessage,
    taskCreationPhase: overrides.taskCreationPhase ?? "idle",
    onChangePrompt: vi.fn(),
    onClose: overrides.onClose ?? vi.fn(),
    onContinueInBackground: overrides.onContinueInBackground ?? vi.fn(),
    onRecover: overrides.onRecover ?? vi.fn(),
    onSelectDesktop: overrides.onSelectDesktop ?? vi.fn(),
    onSelectAgentProvider: overrides.onSelectAgentProvider ?? vi.fn(),
    onToggleOptions: overrides.onToggleOptions ?? vi.fn(),
    onSubmit: overrides.onSubmit ?? vi.fn()
  } as Parameters<NonNullable<typeof CreateTaskComposer>>[0] & {
    selectedAgentProvider: string;
    errorMessage: string | null;
    taskCreationPhase: TaskCreationPhase;
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

  it("shows a compact selected repo and options summary by default", () => {
    const onToggleOptions = vi.fn();
    const tree = renderComposer({ onToggleOptions });
    const optionsToggle = findNodeByTestId(tree, "mobile.create-task.options-toggle");

    expect(findNodeByText(tree, "Repo One")).not.toBeNull();
    expect(findNodeByText(tree, "Studio Mac (online) · Claude")).not.toBeNull();
    expect(findNodeByText(tree, "Copilot")).toBeNull();

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

    (laptopOption?.props?.onPress as (() => void) | undefined)?.();
    (copilotOption?.props?.onPress as (() => void) | undefined)?.();

    expect(onSelectDesktop).toHaveBeenCalledWith("desktop-2");
    expect(onSelectAgentProvider).toHaveBeenCalledWith("copilot");
    expect(AGENT_PROVIDERS).toHaveLength(5);
  });

  it("calls submit when the create button is enabled", () => {
    const onSubmit = vi.fn();
    const tree = renderComposer({ onSubmit });
    const createButton = findNodeByText(tree, "Create");

    (createButton?.props?.onPress as (() => void) | undefined)?.();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(createButton?.props?.disabled).toBe(false);
  });

  it("restores a failed valid submission so it can be retried", () => {
    const onSubmit = vi.fn();
    const tree = renderComposer({
      prompt: "Ship mobile shell",
      selectedRepoId: "repo-1",
      selectedDesktopId: "desktop-1",
      selectedAgentProvider: "claude",
      errorMessage: "Desktop unavailable",
      taskCreationPhase: "idle",
      onSubmit
    });
    const promptInput = findNodeByTestId(tree, "mobile.create-task.prompt");
    const inlineError = findNodeByTestId(tree, "mobile.create-task.error");
    const submitButton = findNodeByTestId(tree, "mobile.create-task.submit");

    expect(findNodeByTestId(tree, "mobile.create-task.provisioning")).toBeNull();
    expect(promptInput?.props?.value).toBe("Ship mobile shell");
    expect(findNodeByText(tree, "Studio Mac (online) · Claude")).not.toBeNull();
    expect(textContent(inlineError)).toBe("Desktop unavailable");
    expect(submitButton).not.toBeNull();
    expect(submitButton?.props?.disabled).toBe(false);

    (submitButton?.props?.onPress as (() => void) | undefined)?.();

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("replaces the composer with a technical provisioning panel", () => {
    const tree = renderComposer({
      taskCreationPhase: "pending",
      selectedAgentProvider: "codex"
    });
    const provisioning = findNodeByTestId(
      tree,
      "mobile.create-task.provisioning"
    );

    expect(provisioning).not.toBeNull();
    expect(findNodeByType(provisioning as ElementNode, "ActivityIndicator")).not.toBeNull();
    const terminalTile = findNodeByText(provisioning as ElementNode, ">_");
    expect(terminalTile?.props).toMatchObject({
      accessibilityElementsHidden: true,
      accessible: false,
      importantForAccessibility: "no-hide-descendants"
    });
    expect(findNodeByText(provisioning as ElementNode, "Workspace boot")).not.toBeNull();
    expect(findNodeByText(provisioning as ElementNode, "Provisioning task")).not.toBeNull();
    expect(
      findNodeByText(
        provisioning as ElementNode,
        "Repo One → Studio Mac · Codex"
      )
    ).not.toBeNull();
    expect(
      findNodeByText(
        provisioning as ElementNode,
        "Creating worktree and starting Codex…"
      )
    ).not.toBeNull();
    expect(findNodeByTestId(tree, "mobile.create-task.prompt")).toBeNull();
    expect(findNodeByTestId(tree, "mobile.create-task.submit")).toBeNull();
    expect(findNodeByText(tree, "Cancel")).toBeNull();
  });

  it("announces provisioning as an indeterminate accessible operation", () => {
    const tree = renderComposer({ taskCreationPhase: "pending" });
    const provisioning = findNodeByTestId(
      tree,
      "mobile.create-task.provisioning"
    );

    expect(provisioning?.props).toMatchObject({
      accessible: true,
      accessibilityLabel:
        "Provisioning task for Repo One on Studio Mac with Claude",
      accessibilityLiveRegion: "polite",
      accessibilityRole: "progressbar",
      accessibilityState: { busy: true }
    });
  });

  it("uses defensive route labels when selections are unavailable", () => {
    const tree = renderComposer({
      taskCreationPhase: "pending",
      selectedRepoId: null,
      selectedDesktopId: null
    });
    const provisioning = findNodeByTestId(
      tree,
      "mobile.create-task.provisioning"
    );

    expect(
      findNodeByText(
        provisioning as ElementNode,
        "Selected repo → Selected machine · Claude"
      )
    ).not.toBeNull();
    expect(provisioning?.props?.accessibilityLabel).toBe(
      "Provisioning task for Selected repo on Selected machine with Claude"
    );
  });

  it("continues provisioning in the background from request-close or the explicit action", () => {
    const onContinueInBackground = vi.fn();
    const tree = renderComposer({
      taskCreationPhase: "pending",
      onContinueInBackground
    });
    const modal = findNodeByType(tree, "Modal");
    const keyboardAvoider = findNodeByType(tree, "KeyboardAvoidingView");
    const backdrop = flattenChildren(keyboardAvoider?.props?.children)[0];
    const backgroundButton = findNodeByTestId(
      tree,
      "mobile.create-task.provisioning.background"
    );

    (modal?.props?.onRequestClose as (() => void) | undefined)?.();
    (backdrop?.props?.onPress as (() => void) | undefined)?.();
    (backgroundButton?.props?.onPress as (() => void) | undefined)?.();

    expect(backdrop?.props).toMatchObject({
      accessibilityElementsHidden: true,
      accessible: false,
      disabled: true,
      importantForAccessibility: "no-hide-descendants"
    });
    expect(backgroundButton?.props?.accessibilityRole).toBe("button");
    expect(onContinueInBackground).toHaveBeenCalledTimes(2);
  });

  it.each(["pending", "uncertain"] as const)(
    "recovers the frozen task identity without exposing a fresh create while %s",
    (taskCreationPhase) => {
      const onRecover = vi.fn();
      const tree = renderComposer({ taskCreationPhase, onRecover });
      const recoverButton = findNodeByTestId(
        tree,
        "mobile.create-task.provisioning.recover"
      );

      expect(findNodeByTestId(tree, "mobile.create-task.prompt")).toBeNull();
      expect(findNodeByTestId(tree, "mobile.create-task.submit")).toBeNull();
      expect(findNodeByText(tree, "Cancel")).toBeNull();
      expect(recoverButton?.props?.disabled).toBe(false);
      expect(recoverButton?.props?.accessibilityRole).toBe("button");

      (recoverButton?.props?.onPress as (() => void) | undefined)?.();
      expect(onRecover).toHaveBeenCalledTimes(1);
    }
  );

  it("keeps recovery single-flight in the UI while reconciliation is running", () => {
    const onRecover = vi.fn();
    const tree = renderComposer({ taskCreationPhase: "recovering", onRecover });
    const recoverButton = findNodeByTestId(
      tree,
      "mobile.create-task.provisioning.recover"
    );

    expect(recoverButton?.props?.disabled).toBe(true);
    expect(findNodeByText(tree, "Recovering…")).not.toBeNull();
    (recoverButton?.props?.onPress as (() => void) | undefined)?.();
    expect(onRecover).not.toHaveBeenCalled();
  });

  it("explains an ambiguous result without claiming that creation failed", () => {
    const tree = renderComposer({
      taskCreationPhase: "uncertain",
      errorMessage: "Relay connection closed."
    });

    expect(findNodeByText(tree, "Task result unknown")).not.toBeNull();
    expect(
      findNodeByText(
        tree,
        "The desktop may already have created this task. Recover checks the same task identity."
      )
    ).not.toBeNull();
    expect(findNodeByText(tree, "Relay connection closed.")).not.toBeNull();
    expect(
      findNodeByTestId(tree, "mobile.create-task.provisioning")?.props
        ?.accessibilityLabel
    ).toBe(
      "Task result unknown for Repo One on Studio Mac. Relay connection closed."
    );
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
    expect(findNodeByTestId(tree, "mobile.create-task.provisioning")).toBeNull();
    expect(createButton?.props?.disabled).toBe(true);
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
