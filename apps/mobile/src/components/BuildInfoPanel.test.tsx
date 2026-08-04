import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { BuildIdentity } from "../lib/updates/buildIdentity";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("../lib/diagnostics/mobileCrashDiagnostics", () => ({
  clearMobileCrashDiagnostics: vi.fn().mockResolvedValue(undefined),
  formatMobileCrashDiagnostics: (records: unknown) => JSON.stringify(records),
  readMobileCrashDiagnostics: vi.fn().mockResolvedValue([])
}));
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
    expect(
      rendered.root.findByProps({ testID: "mobile.build-info.native" }).children
    ).toContain("2.4.0 (108)");
    expect(
      rendered.root.findByProps({ testID: "mobile.build-info.runtime" }).children
    ).toContain("2.1.2");
    expect(
      rendered.root.findByProps({ testID: "mobile.build-info.environment" })
        .children
    ).toContain("staging");
    expect(
      rendered.root.findByProps({ testID: "mobile.build-info.channel" }).children
    ).toContain("staging");
    expect(
      rendered.root.findByProps({
        testID: "mobile.build-info.running-source"
      }).children
    ).toHaveLength(1);
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
      rendered.root.findByProps({
        testID: "mobile.build-info.running-source"
      }).children
    ).toContain("Embedded bundle");
    expect(
      rendered.root.findAllByProps({ testID: "mobile.build-info.update-id" })
    ).toHaveLength(0);
  });

  it("loads, copies, and clears retained crash diagnostics", async () => {
    if (!BuildInfoPanel) throw new Error("BuildInfoPanel was not loaded");
    const diagnostic = {
      schemaVersion: 1 as const,
      id: "diagnostic-123",
      at: "2026-08-04T03:00:00.000Z",
      kind: "webview-process-terminated" as const,
      fatal: false,
      message: "The iOS terminal WebView content process terminated.",
      context: {
        appState: "active",
        connectionMode: "lan",
        connectionState: "connected",
        forceCloudEnabled: false,
        selectedTaskId: "task-1",
        terminalCols: 120,
        terminalOutputChars: 900_000,
        terminalOutputEpoch: 3,
        terminalOutputStart: 100_000,
        terminalRows: 44,
        terminalStatus: "live"
      },
      breadcrumbs: [],
      build: {
        channel: "staging",
        environment: "staging",
        nativeSummary: "2.4.0 (108)",
        runtimeVersion: "2.1.4",
        source: "ota-123"
      }
    };
    const copyDiagnostics = vi.fn().mockResolvedValue(undefined);
    const loadDiagnostics = vi.fn().mockResolvedValue([diagnostic]);
    const removeDiagnostics = vi.fn().mockResolvedValue(undefined);

    await act(async () => {
      rendered = create(
        React.createElement(BuildInfoPanel!, {
          identity: otaIdentity,
          copyDiagnostics,
          loadDiagnostics,
          removeDiagnostics
        })
      );
    });
    await act(async () => {
      rendered?.root.findByProps({ testID: "mobile.build-info.toggle" }).props.onPress();
      await Promise.resolve();
    });

    expect(copy()).toContain("diagnostic-123");
    expect(copy()).toContain("webview-process-terminated");

    await act(async () => {
      await rendered?.root.findByProps({
        testID: "mobile.crash-diagnostics.copy"
      }).props.onPress();
    });
    expect(copyDiagnostics).toHaveBeenCalledWith(
      expect.stringContaining('"id":"diagnostic-123"')
    );

    await act(async () => {
      await rendered?.root.findByProps({
        testID: "mobile.crash-diagnostics.clear"
      }).props.onPress();
    });
    expect(removeDiagnostics).toHaveBeenCalledTimes(1);
    expect(copy()).toContain("No retained crash diagnostics.");
  });
});
