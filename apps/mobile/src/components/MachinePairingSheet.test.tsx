import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const reactState = vi.hoisted(() => ({ index: 0, values: [] as unknown[] }));
const reactRefs = vi.hoisted(() => ({ index: 0, values: [] as Array<{ current: unknown }> }));
const cameraPermission = vi.hoisted(() => ({
  current: { granted: true, canAskAgain: true }
}));

vi.mock("react", async (importActual) => {
  const actual = await importActual<typeof import("react")>();
  return {
    ...actual,
    useState: <T,>(initial: T) => {
      const index = reactState.index++;
      if (reactState.values.length <= index) reactState.values[index] = initial;
      return [
        reactState.values[index] as T,
        (next: T | ((current: T) => T)) => {
          const current = reactState.values[index] as T;
          reactState.values[index] = typeof next === "function"
            ? (next as (value: T) => T)(current)
            : next;
        }
      ] as const;
    },
    useRef: <T,>(current: T) => {
      const index = reactRefs.index++;
      if (reactRefs.values.length <= index) reactRefs.values[index] = { current };
      return reactRefs.values[index] as { current: T };
    }
  };
});

vi.mock("expo-camera", () => ({
  CameraView: "CameraView",
  useCameraPermissions: () => [cameraPermission.current, vi.fn()]
}));

vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  KeyboardAvoidingView: "KeyboardAvoidingView",
  Linking: { openSettings: vi.fn() },
  Modal: "Modal",
  Platform: { OS: "ios" },
  Pressable: "Pressable",
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: "Text",
  TextInput: "TextInput",
  View: "View"
}));

interface Node {
  type: unknown;
  props?: { children?: Child | Child[]; [key: string]: any };
}
type Child = Node | string | null | undefined;

function children(node: Child | Child[]): Node[] {
  const values = Array.isArray(node) ? node : [node];
  return values.filter((value): value is Node => Boolean(value) && typeof value !== "string");
}

function find(node: Child | Child[], predicate: (node: Node) => boolean): Node | null {
  for (const candidate of children(node)) {
    if (predicate(candidate)) return candidate;
    const nested = find(candidate.props?.children ?? [], predicate);
    if (nested) return nested;
  }
  return null;
}

function findByTestId(node: Node, testID: string) {
  return find(node, (candidate) => candidate.props?.testID === testID);
}

function findByType(node: Node, type: string) {
  return find(node, (candidate) => candidate.type === type);
}

function findPressableByText(node: Node, text: string) {
  return find(node, (candidate) =>
    candidate.type === "Pressable" &&
    Boolean(find(candidate.props?.children ?? [], (child) =>
      child.type === "Text" && child.props?.children === text
    ))
  );
}

let MachinePairingSheet: typeof import("./MachinePairingSheet").MachinePairingSheet;

beforeAll(async () => {
  MachinePairingSheet = (await import("./MachinePairingSheet")).MachinePairingSheet;
});

beforeEach(() => {
  reactState.index = 0;
  reactState.values = [];
  reactRefs.index = 0;
  reactRefs.values = [];
  cameraPermission.current = { granted: true, canAskAgain: true };
});

function render(overrides: Partial<Parameters<typeof MachinePairingSheet>[0]> = {}) {
  reactState.index = 0;
  reactRefs.index = 0;
  return MachinePairingSheet({
    visible: true,
    onClose: vi.fn(),
    onPairCode: vi.fn(async () => undefined),
    onPairPayload: vi.fn(async () => undefined),
    ...overrides
  }) as Node;
}

describe("MachinePairingSheet", () => {
  it("keeps code entry available when camera permission is denied", () => {
    cameraPermission.current = { granted: false, canAskAgain: false };

    const tree = render();

    expect(findByTestId(tree, "mobile.machine-pairing.code")).not.toBeNull();
    expect(findByTestId(tree, "mobile.machine-pairing.open-settings")).not.toBeNull();
  });

  it("submits only the first QR scan until pairing settles", async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((nextResolve) => { resolve = nextResolve; });
    const onPairPayload = vi.fn(() => pending);
    const tree = render({ onPairPayload });
    const camera = findByType(tree, "CameraView");

    camera?.props?.onBarcodeScanned?.({ type: "qr", data: "pairing-payload" });
    camera?.props?.onBarcodeScanned?.({ type: "qr", data: "pairing-payload" });

    expect(onPairPayload).toHaveBeenCalledTimes(1);
    resolve();
    await pending;
  });

  it("forwards the exact desktop-generated compact payload from the camera", async () => {
    const onPairPayload = vi.fn(async () => undefined);
    const payload = "KANNA1:DESKTOP-21B320E8-A5AD-4FAE-9D87-1DB14090F0A9:386A02";
    const tree = render({ onPairPayload });

    findByType(tree, "CameraView")?.props?.onBarcodeScanned?.({
      type: "qr",
      data: payload
    });
    await Promise.resolve();

    expect(onPairPayload).toHaveBeenCalledOnce();
    expect(onPairPayload).toHaveBeenCalledWith(payload);
  });

  it("latches a failed visible QR until an explicit retry succeeds", async () => {
    const onClose = vi.fn();
    const onPairPayload = vi.fn(async () => undefined);
    onPairPayload.mockRejectedValueOnce(new Error("No matching machine was found"));
    let tree = render({ onClose, onPairPayload });

    findByType(tree, "CameraView")?.props?.onBarcodeScanned?.({
      type: "qr",
      data: "continuously-visible-payload"
    });
    await Promise.resolve();
    tree = render({ onClose, onPairPayload });

    expect(findByTestId(tree, "mobile.machine-pairing.error")?.props?.children)
      .toBe("No matching machine was found");
    const camera = findByType(tree, "CameraView");
    camera?.props?.onBarcodeScanned?.({
      type: "qr",
      data: "continuously-visible-payload"
    });
    camera?.props?.onBarcodeScanned?.({
      type: "qr",
      data: "continuously-visible-payload"
    });
    expect(onPairPayload).toHaveBeenCalledTimes(1);

    findPressableByText(tree, "Retry scan")?.props?.onPress?.();
    tree = render({ onClose, onPairPayload });
    findByType(tree, "CameraView")?.props?.onBarcodeScanned?.({
      type: "qr",
      data: "continuously-visible-payload"
    });
    await Promise.resolve();

    expect(onPairPayload).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("accepts a meaningfully different QR after a failed scan", async () => {
    const onPairPayload = vi.fn(async () => undefined);
    onPairPayload.mockRejectedValueOnce(new Error("No matching machine was found"));
    let tree = render({ onPairPayload });

    findByType(tree, "CameraView")?.props?.onBarcodeScanned?.({
      type: "qr",
      data: "failed-payload"
    });
    await Promise.resolve();
    tree = render({ onPairPayload });
    findByType(tree, "CameraView")?.props?.onBarcodeScanned?.({
      type: "qr",
      data: "different-payload"
    });
    await Promise.resolve();

    expect(onPairPayload).toHaveBeenNthCalledWith(1, "failed-payload");
    expect(onPairPayload).toHaveBeenNthCalledWith(2, "different-payload");
  });

  it("shows pairing progress instead of the scanner while a claim is in flight", async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((nextResolve) => { resolve = nextResolve; });
    const onPairPayload = vi.fn(() => pending);
    let tree = render({ onPairPayload });

    findByType(tree, "CameraView")?.props?.onBarcodeScanned?.({
      type: "qr",
      data: "pairing-payload"
    });
    tree = render({ onPairPayload });

    const progress = findByTestId(tree, "mobile.machine-pairing.progress");
    expect(progress).not.toBeNull();
    expect(find(progress!, (node) =>
      node.type === "Text" &&
      typeof node.props?.children === "string" &&
      node.props.children.includes("loading its tasks")
    )).not.toBeNull();
    expect(findByType(tree, "CameraView")).toBeNull();
    expect(findByTestId(tree, "mobile.machine-pairing.code")?.props?.editable).toBe(false);

    resolve();
    await pending;
  });

  it("normalizes and submits a six-character code", async () => {
    const onPairCode = vi.fn(async () => undefined);
    let tree = render({ onPairCode });
    findByTestId(tree, "mobile.machine-pairing.code")?.props?.onChangeText?.("abc 123");
    tree = render({ onPairCode });

    await findByTestId(tree, "mobile.machine-pairing.submit")?.props?.onPress?.();

    expect(onPairCode).toHaveBeenCalledWith("ABC123");
  });

  it("reopens in a fresh scan state after successful code pairing", async () => {
    const onClose = vi.fn();
    const onPairCode = vi.fn(async () => undefined);
    onPairCode.mockRejectedValueOnce(new Error("That code was already used"));
    let tree = render({ onClose, onPairCode });

    findPressableByText(tree, "Enter code")?.props?.onPress?.();
    tree = render({ onClose, onPairCode });
    findByTestId(tree, "mobile.machine-pairing.code")?.props?.onChangeText?.("ABC123");
    tree = render({ onClose, onPairCode });
    await findByTestId(tree, "mobile.machine-pairing.submit")?.props?.onPress?.();
    tree = render({ onClose, onPairCode });
    expect(findByTestId(tree, "mobile.machine-pairing.error")).not.toBeNull();

    await findByTestId(tree, "mobile.machine-pairing.submit")?.props?.onPress?.();

    tree = render({ onClose, onPairCode, visible: true });

    expect(onClose).toHaveBeenCalledOnce();
    expect(onPairCode).toHaveBeenCalledTimes(2);
    expect(findByTestId(tree, "mobile.machine-pairing.code")?.props?.value).toBe("");
    expect(findByType(tree, "CameraView")).not.toBeNull();
    expect(findByType(tree, "ActivityIndicator")).toBeNull();
    expect(findByType(tree, "KeyboardAvoidingView")?.props?.children?.[0]?.props).toMatchObject({
      accessibilityElementsHidden: true,
      accessible: false,
      importantForAccessibility: "no-hide-descendants"
    });
    expect(findPressableByText(tree, "Scan QR")?.props).toMatchObject({
      accessibilityRole: "tab",
      accessibilityState: { selected: true },
      testID: "mobile.machine-pairing.mode.scan"
    });
    expect(findByTestId(tree, "mobile.machine-pairing.code")?.props).toMatchObject({
      accessibilityLabel: "Pairing code"
    });
    expect(findByTestId(tree, "mobile.machine-pairing.submit")?.props).toMatchObject({
      accessibilityLabel: "Add machine",
      accessibilityRole: "button",
      accessibilityState: { busy: false, disabled: true }
    });
    expect(findByTestId(tree, "mobile.machine-pairing.submit")?.props?.disabled).toBe(true);
    expect(findByTestId(tree, "mobile.machine-pairing.error")).toBeNull();
  });
});
