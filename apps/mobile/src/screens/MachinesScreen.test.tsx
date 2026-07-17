import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Alert } from "react-native";

vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: "Text",
  View: "View"
}));

vi.mock("../components/MachinePairingSheet", () => ({
  MachinePairingSheet: "MachinePairingSheet"
}));

interface Node {
  type: unknown;
  props?: { children?: Child | Child[]; [key: string]: any };
}
type Child = Node | string | null | undefined | false;

function textContent(node: Child | Child[]): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (typeof node.type === "function") {
    return textContent(node.type(node.props ?? {}));
  }
  return textContent(node.props?.children ?? []);
}

function findByTestId(node: Child | Child[], testID: string): Node | null {
  if (!node || typeof node === "string") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByTestId(child, testID);
      if (found) return found;
    }
    return null;
  }
  if (typeof node.type === "function") {
    return findByTestId(node.type(node.props ?? {}), testID);
  }
  if (node.props?.testID === testID) return node;
  return findByTestId(node.props?.children ?? [], testID);
}

let MachinesScreen: typeof import("./MachinesScreen").MachinesScreen;

beforeAll(async () => {
  MachinesScreen = (await import("./MachinesScreen")).MachinesScreen;
});

beforeEach(() => {
  vi.mocked(Alert.alert).mockClear();
});

describe("MachinesScreen", () => {
  it("groups deduplicated machines and only offers removal for manual origins", () => {
    const tree = MachinesScreen({
      machines: [
        {
          desktopId: "desktop-dual",
          displayName: "Jerome’s MacBook Pro",
          origins: { account: true, manual: true },
          availability: { lan: true, cloud: true, lastSeenAt: null },
          lanEndpoints: []
        },
        {
          desktopId: "desktop-account",
          displayName: "Account Mac",
          origins: { account: true, manual: false },
          availability: { lan: false, cloud: false, lastSeenAt: null },
          lanEndpoints: []
        }
      ],
      sourceWarnings: { account: null, local: null },
      pairingVisible: false,
      onBack: vi.fn(),
      onOpenPairing: vi.fn(),
      onClosePairing: vi.fn(),
      onPairCode: vi.fn(async () => undefined),
      onPairPayload: vi.fn(async () => undefined),
      onRemoveManual: vi.fn(async () => undefined)
    }) as Node;

    expect(textContent(tree)).toContain("Available");
    expect(textContent(tree)).toContain("Offline");
    expect(textContent(tree)).toContain("Account");
    expect(textContent(tree)).toContain("Paired");
    expect(textContent(tree).match(/Jerome’s MacBook Pro/g)).toHaveLength(1);
    expect(findByTestId(tree, "mobile.machine.desktop-dual.remove")).not.toBeNull();
    expect(findByTestId(tree, "mobile.machine.desktop-dual.name")).not.toBeNull();
    expect(findByTestId(tree, "mobile.machine.desktop-dual.origin.account")).not.toBeNull();
    expect(findByTestId(tree, "mobile.machine.desktop-dual.origin.manual")).not.toBeNull();
    expect(findByTestId(tree, "mobile.machine.desktop-account.remove")).toBeNull();
    expect(findByTestId(tree, "mobile.machines-back")).not.toBeNull();
    expect(findByTestId(tree, "mobile.machines-add")).not.toBeNull();
  });

  it("shows source warnings without hiding cached machine rows", () => {
    const tree = MachinesScreen({
      machines: [{
        desktopId: "desktop-cached",
        displayName: "Cached Mac",
        origins: { account: true, manual: false },
        availability: { lan: false, cloud: false, lastSeenAt: null },
        lanEndpoints: []
      }],
      sourceWarnings: { account: "Cloud unavailable", local: "LAN unavailable" },
      pairingVisible: false,
      onBack: vi.fn(),
      onOpenPairing: vi.fn(),
      onClosePairing: vi.fn(),
      onPairCode: vi.fn(async () => undefined),
      onPairPayload: vi.fn(async () => undefined),
      onRemoveManual: vi.fn(async () => undefined)
    }) as Node;

    expect(textContent(tree)).toContain("Cloud unavailable");
    expect(textContent(tree)).toContain("LAN unavailable");
    expect(textContent(tree)).toContain("Cached Mac");
  });

  it("reports a failed manual removal instead of discarding the error", async () => {
    const removalError = new Error("Secure storage is unavailable");
    const tree = MachinesScreen({
      machines: [{
        desktopId: "desktop-manual",
        displayName: "Paired Mac",
        origins: { account: false, manual: true },
        availability: { lan: false, cloud: false, lastSeenAt: null },
        lanEndpoints: []
      }],
      sourceWarnings: { account: null, local: null },
      pairingVisible: false,
      onBack: vi.fn(),
      onOpenPairing: vi.fn(),
      onClosePairing: vi.fn(),
      onPairCode: vi.fn(async () => undefined),
      onPairPayload: vi.fn(async () => undefined),
      onRemoveManual: vi.fn(async () => Promise.reject(removalError))
    }) as Node;

    findByTestId(tree, "mobile.machine.desktop-manual.remove")?.props?.onPress?.();
    const confirmationButtons = vi.mocked(Alert.alert).mock.calls[0]?.[2];
    confirmationButtons?.find((button) => button.text === "Remove")?.onPress?.();

    await vi.waitFor(() => {
      expect(Alert.alert).toHaveBeenLastCalledWith(
        "Couldn’t remove machine",
        "Secure storage is unavailable"
      );
    });
  });
});
