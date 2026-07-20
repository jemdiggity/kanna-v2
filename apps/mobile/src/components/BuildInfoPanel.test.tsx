import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { BuildIdentity } from "../lib/updates/buildIdentity";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("react-native", () => ({
  Pressable: "Pressable",
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T) => styles
  },
  Text: "Text",
  View: "View"
}));

let BuildInfoPanel:
  | typeof import("./BuildInfoPanel").BuildInfoPanel
  | null = null;
let rendered: ReactTestRenderer | null = null;

const otaIdentity: BuildIdentity = {
  nativeVersion: "2.4.0",
  nativeBuild: "108",
  nativeSummary: "2.4.0 (108)",
  runtimeVersion: "2.1.2",
  environment: "staging",
  channel: "staging",
  source: {
    kind: "ota",
    label: "84667f93-5c7b-45fb-9f78-7045160cb842",
    updateId: "84667f93-5c7b-45fb-9f78-7045160cb842"
  }
};

beforeAll(async () => {
  BuildInfoPanel = (await import("./BuildInfoPanel")).BuildInfoPanel;
});

afterEach(async () => {
  if (rendered) {
    await act(async () => rendered?.unmount());
    rendered = null;
  }
  vi.useRealTimers();
});

function copy(): string {
  if (!rendered) return "";
  return rendered.root
    .findAll((node) => node.type === "Text")
    .flatMap((node) => node.children)
    .join(" ");
}

describe("BuildInfoPanel", () => {
  it("stays compact until the operator expands exact build details", async () => {
    if (!BuildInfoPanel) throw new Error("BuildInfoPanel was not loaded");

    await act(async () => {
      rendered = create(
        React.createElement(BuildInfoPanel!, { identity: otaIdentity })
      );
    });

    expect(copy()).toContain("About this build");
    expect(copy()).toContain("2.4.0 (108)");
    expect(copy()).not.toContain("Runtime");

    await act(async () => {
      rendered?.root.findByProps({ testID: "mobile.build-info.toggle" }).props.onPress();
    });

    expect(copy()).toContain("Native");
    expect(copy()).toContain("Runtime");
    expect(copy()).toContain("Environment");
    expect(copy()).toContain("Channel");
    expect(copy()).toContain("Running source");
    expect(copy()).toContain("84667f93-5c7b-45fb-9f78-7045160cb842");
  });

  it("copies the full update ID and resets its feedback", async () => {
    if (!BuildInfoPanel) throw new Error("BuildInfoPanel was not loaded");
    vi.useFakeTimers();
    const copyUpdateId = vi.fn().mockResolvedValue(undefined);

    await act(async () => {
      rendered = create(
        React.createElement(BuildInfoPanel!, { identity: otaIdentity, copyUpdateId })
      );
    });
    await act(async () => {
      rendered?.root.findByProps({ testID: "mobile.build-info.toggle" }).props.onPress();
    });
    await act(async () => {
      await rendered?.root.findByProps({
        testID: "mobile.build-info.update-id"
      }).props.onPress();
    });

    expect(copyUpdateId).toHaveBeenCalledWith(
      "84667f93-5c7b-45fb-9f78-7045160cb842"
    );
    expect(
      rendered.root.findByProps({ testID: "mobile.build-info.copy-hint" })
        .children
    ).toContain("Copied");

    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });

    expect(
      rendered.root.findByProps({ testID: "mobile.build-info.copy-hint" })
        .children
    ).toContain("Tap to copy");
  });

  it("renders an embedded bundle as plain text without a copy action", async () => {
    if (!BuildInfoPanel) throw new Error("BuildInfoPanel was not loaded");

    await act(async () => {
      rendered = create(
        React.createElement(BuildInfoPanel!, {
          identity: {
            ...otaIdentity,
            source: { kind: "embedded", label: "Embedded bundle" }
          }
        })
      );
    });
    await act(async () => {
      rendered?.root.findByProps({ testID: "mobile.build-info.toggle" }).props.onPress();
    });

    expect(copy()).toContain("Embedded bundle");
    expect(
      rendered.root.findAllByProps({ testID: "mobile.build-info.update-id" })
    ).toHaveLength(0);
  });
});
