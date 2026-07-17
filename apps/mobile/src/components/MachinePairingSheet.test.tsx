import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const reactState = vi.hoisted(() => ({ index: 0, values: [] as unknown[] }));
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
    useRef: <T,>(current: T) => ({ current })
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

let MachinePairingSheet: typeof import("./MachinePairingSheet").MachinePairingSheet;

beforeAll(async () => {
  MachinePairingSheet = (await import("./MachinePairingSheet")).MachinePairingSheet;
});

beforeEach(() => {
  reactState.index = 0;
  reactState.values = [];
  cameraPermission.current = { granted: true, canAskAgain: true };
});

function render(overrides: Partial<Parameters<typeof MachinePairingSheet>[0]> = {}) {
  reactState.index = 0;
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

  it("normalizes and submits a six-character code", async () => {
    const onPairCode = vi.fn(async () => undefined);
    let tree = render({ onPairCode });
    findByTestId(tree, "mobile.machine-pairing.code")?.props?.onChangeText?.("abc 123");
    tree = render({ onPairCode });

    await findByTestId(tree, "mobile.machine-pairing.submit")?.props?.onPress?.();

    expect(onPairCode).toHaveBeenCalledWith("ABC123");
  });
});
