import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
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

function props() {
  return {
    repos: [{ id: "repo-1", name: "Kanna" }],
    selectedRepoId: "repo-1",
    catalog: {
      repoId: "repo-1",
      revision: "v1",
      commands: [
        {
          id: "custom:merge-master",
          label: "Merge Master",
          description: "Merge ready pull requests",
          group: "automation" as const
        }
      ]
    },
    status: "ready" as const,
    errorMessage: null,
    runningCommandId: null,
    onSelectRepo: vi.fn(),
    onRunCommand: vi.fn(),
    onRetry: vi.fn()
  };
}

describe("MoreScreen", () => {
  it("renders only grouped repository commands and runs the selected entry", async () => {
    if (!MoreScreen) throw new Error("MoreScreen was not loaded");
    const input = props();

    await act(async () => {
      rendered = create(React.createElement(MoreScreen!, input));
    });

    const copy = rendered.root
      .findAll((node) => node.type === "Text")
      .flatMap((node) => node.children)
      .join(" ");
    expect(copy).toContain("Automations");
    expect(copy).toContain("Merge Master");
    expect(copy).not.toContain("Refresh Data");
    expect(copy).not.toContain("Create Task");

    expect(
      rendered.root.find(
        (node) => node.props.testID === "mobile.more.repo.repo-1"
      )
    ).toBeDefined();
    expect(
      rendered.root.find(
        (node) =>
          node.props.testID === "mobile.more.command-group.automation"
      )
    ).toBeDefined();

    const command = rendered.root.find(
      (node) => node.props.testID === "mobile.more.command.custom:merge-master"
    );
    command.props.onPress();
    expect(input.onRunCommand).toHaveBeenCalledWith("custom:merge-master");
  });

  it("shows visible pressed feedback for repository commands", async () => {
    if (!MoreScreen) throw new Error("MoreScreen was not loaded");

    await act(async () => {
      rendered = create(React.createElement(MoreScreen!, props()));
    });

    const command = rendered.root.find(
      (node) => node.props.testID === "mobile.more.command.custom:merge-master"
    );
    expect(command.props.style).toBeTypeOf("function");
    expect(command.props.style({ pressed: true })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          backgroundColor: "#182842",
          borderColor: "#3A5F91",
          opacity: 0.82,
          transform: [{ scale: 0.98 }]
        })
      ])
    );
    expect(command.props.style({ pressed: true })).not.toEqual(
      command.props.style({ pressed: false })
    );
  });

  it("keeps repository selection disabled while a command is running", async () => {
    if (!MoreScreen) throw new Error("MoreScreen was not loaded");
    const input = {
      ...props(),
      repos: [
        { id: "repo-1", name: "Kanna" },
        { id: "repo-2", name: "Kanna Docs" }
      ],
      runningCommandId: "custom:merge-master"
    };

    await act(async () => {
      rendered = create(React.createElement(MoreScreen!, input));
    });

    const repo = rendered.root.find(
      (node) => node.props.testID === "mobile.more.repo.repo-2"
    );
    expect(repo.props.disabled).toBe(true);
    repo.props.onPress();
    expect(input.onSelectRepo).not.toHaveBeenCalled();
  });

  it("shows command task loading failures with a retry action", async () => {
    if (!MoreScreen) throw new Error("MoreScreen was not loaded");
    const input = {
      ...props(),
      status: "error" as const,
      errorMessage:
        "The command launched successfully, but its task could not be loaded. Check your connection and try again."
    };

    await act(async () => {
      rendered = create(React.createElement(MoreScreen!, input));
    });

    const copy = rendered.root
      .findAll((node) => node.type === "Text")
      .flatMap((node) => node.children)
      .join(" ");
    expect(copy).toContain("command launched successfully");
    expect(copy).toContain("Check your connection and try again");

    const retry = rendered.root.find(
      (node) => node.type === "Pressable" && node.props.onPress === input.onRetry
    );
    retry.props.onPress();
    expect(input.onRetry).toHaveBeenCalledOnce();
  });

  it("does not expose OTA diagnostics", async () => {
    if (!MoreScreen) throw new Error("MoreScreen was not loaded");

    await act(async () => {
      rendered = create(
        React.createElement(MoreScreen!, {
          ...props(),
          updateInfo: {
            enabled: true,
            updateId: "0123456789abcdef",
            runtimeVersion: "2.0.0",
            channel: "staging"
          }
        } as Parameters<typeof MoreScreen>[0])
      );
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
