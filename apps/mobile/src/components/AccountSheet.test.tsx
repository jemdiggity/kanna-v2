import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Modal: "Modal",
  Pressable: "Pressable",
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T) => styles
  },
  Text: "Text",
  TextInput: "TextInput",
  View: "View"
}));

let getConnectionStatusPresentation:
  | typeof import("./AccountSheet").getConnectionStatusPresentation
  | null = null;

beforeAll(async () => {
  const module = await import("./AccountSheet");
  getConnectionStatusPresentation = module.getConnectionStatusPresentation;
});

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
