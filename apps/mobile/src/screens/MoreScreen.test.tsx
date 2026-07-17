import React from "react";
import {
  act,
  create,
  type ReactTestRenderer
} from "react-test-renderer";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T) => styles
  },
  Text: "Text",
  TextInput: "TextInput",
  View: "View"
}));

let MoreScreen: typeof import("./MoreScreen").MoreScreen | null = null;
let rendered: ReactTestRenderer | null = null;

beforeAll(async () => {
  MoreScreen = (await import("./MoreScreen")).MoreScreen;
});

afterEach(async () => {
  if (rendered) {
    await act(async () => rendered?.unmount());
    rendered = null;
  }
});

describe("MoreScreen", () => {
  it("visibly responds while the advance-stage command is pressed", async () => {
    if (!MoreScreen) throw new Error("MoreScreen was not loaded");

    const props = {
      pairingCode: null,
      refreshStatus: "idle",
      selectedTask: {
        id: "task-1",
        repoId: "repo-1",
        title: "Review mobile shell",
        stage: "review"
      },
      onRefresh: vi.fn(),
      onShowDesktops: vi.fn(),
      onStartPairing: vi.fn(),
      onOpenComposer: vi.fn(),
      onAdvanceTaskStage: vi.fn(),
      onRunMergeAgent: vi.fn(),
      onCloseTask: vi.fn()
    } as Parameters<typeof MoreScreen>[0];

    await act(async () => {
      rendered = create(React.createElement(MoreScreen, props));
    });

    const advanceStageButton = rendered.root
      .findAll((node) => node.type === "Pressable")
      .find((node) =>
        node
          .findAll((child) => child.type === "Text")
          .some((child) => child.children.join("") === "Advance Stage")
      );
    const resolveStyle = advanceStageButton?.props.style;

    expect(resolveStyle).toBeTypeOf("function");
    expect(resolveStyle({ pressed: true })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          opacity: expect.any(Number),
          transform: [{ scale: expect.any(Number) }]
        })
      ])
    );
    expect(resolveStyle({ pressed: true })).not.toEqual(
      resolveStyle({ pressed: false })
    );
  });

  it("does not expose OTA diagnostics", async () => {
    if (!MoreScreen) throw new Error("MoreScreen was not loaded");

    const props = {
      pairingCode: null,
      refreshStatus: "idle",
      selectedTask: null,
      updateInfo: {
        enabled: true,
        updateId: "0123456789abcdef",
        runtimeVersion: "2.0.0",
        channel: "staging"
      },
      onRefresh: vi.fn(),
      onShowDesktops: vi.fn(),
      onStartPairing: vi.fn(),
      onOpenComposer: vi.fn(),
      onAdvanceTaskStage: vi.fn(),
      onRunMergeAgent: vi.fn(),
      onCloseTask: vi.fn()
    } as Parameters<typeof MoreScreen>[0];

    await act(async () => {
      rendered = create(React.createElement(MoreScreen, props));
    });

    const copy = rendered.root
      .findAll((node) => node.type === "Text")
      .flatMap((node) => node.children)
      .join(" ");
    expect(copy).not.toContain("App update");
    expect(copy).not.toContain("staging");
    expect(copy).not.toContain("2.0.0");
    expect(copy).not.toContain("01234567");
  });
});
