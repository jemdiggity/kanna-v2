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
vi.mock("../components/BuildInfoPanel", () => ({
  BuildInfoPanel: "BuildInfoPanel"
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
        "The task was created, but it could not be opened here yet. Find it on the Tasks tab, or try again."
    };

    await act(async () => {
      rendered = create(React.createElement(MoreScreen!, input));
    });

    const copy = rendered.root
      .findAll((node) => node.type === "Text")
      .flatMap((node) => node.children)
      .join(" ");
    expect(copy).toContain("task was created");
    expect(copy).toContain("Find it on the Tasks tab");

    const retry = rendered.root.find(
      (node) => node.type === "Pressable" && node.props.onPress === input.onRetry
    );
    retry.props.onPress();
    expect(input.onRetry).toHaveBeenCalledOnce();
  });

  it("renders an actionable canonical repository routing error", async () => {
    if (!MoreScreen) throw new Error("MoreScreen was not loaded");
    const input = {
      ...props(),
      status: "error" as const,
      errorMessage:
        'Repository "git:missing-hash" is not registered on a reachable paired desktop.'
    };

    await act(async () => {
      rendered = create(React.createElement(MoreScreen!, input));
    });

    const copy = rendered.root
      .findAll((node) => node.type === "Text")
      .flatMap((node) => node.children)
      .join(" ");
    expect(copy).toContain("Commands unavailable");
    expect(copy).toContain(
      'Repository "git:missing-hash" is not registered on a reachable paired desktop.'
    );
  });

  it("places compact build information after repository commands", async () => {
    if (!MoreScreen) throw new Error("MoreScreen was not loaded");

    await act(async () => {
      rendered = create(React.createElement(MoreScreen!, props()));
    });

    const nodes = rendered.root.findAll(() => true);
    const panels = nodes.filter((node) => node.type === "BuildInfoPanel");
    const commandGroup = nodes.find(
      (node) => node.props.testID === "mobile.more.command-group.automation"
    );

    expect(panels).toHaveLength(1);
    expect(commandGroup).toBeDefined();
    expect(nodes.indexOf(panels[0])).toBeGreaterThan(
      nodes.indexOf(commandGroup!)
    );
  });
});
