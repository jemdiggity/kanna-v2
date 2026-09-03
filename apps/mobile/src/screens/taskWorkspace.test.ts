import { describe, expect, it } from "vitest";
import { buildTaskWorkspaceModel } from "./taskWorkspace";

describe("buildTaskWorkspaceModel", () => {
  it("returns a compact header model for healthy task detail state", () => {
    const model = buildTaskWorkspaceModel({
      task: {
        id: "task-123",
        repoId: "repo-1",
        title: "Fix task reactivity in mobile app after desktop daemon reconnect regression",
        stage: "in progress",
        waitingPromptSnippet: "recent output"
      },
      terminalStatus: "live"
    });

    expect(model.stageLabel).toBe("in progress");
    expect(model.title).toBe(
      "Fix task reactivity in mobile app after desktop daemon reconnect regression"
    );
    expect(model.isTerminalHealthy).toBe(true);
    expect(model.overlayLabel).toBeNull();
    expect(model.isComposerDisabled).toBe(false);
    expect(model.chromeStyle).toBe("floating");
    expect(model.terminalLayout).toBe("fullscreen");
    expect(model.titlePresentation).toBe("chip");
  });

  it("maps unhealthy terminal states to overlay copy and disables the composer", () => {
    expect(
      buildTaskWorkspaceModel({
        task: {
          id: "task-closed",
          repoId: "repo-1",
          title: "Close the task",
          stage: "pr"
        },
        terminalStatus: "closed"
      })
    ).toMatchObject({
      isTerminalHealthy: false,
      overlayLabel: "Offline",
      isComposerDisabled: true,
      chromeStyle: "floating",
      terminalLayout: "fullscreen",
      titlePresentation: "chip"
    });

    expect(
      buildTaskWorkspaceModel({
        task: {
          id: "task-error",
          repoId: "repo-1",
          title: "Reconnect the terminal",
          stage: "in progress"
        },
        terminalStatus: "error",
        terminalErrorMessage: "Relay connection closed"
      }).overlayLabel
    ).toBe("Relay connection closed");
  });

  it("falls back to generic terminal error copy when no stream message is available", () => {
    expect(
      buildTaskWorkspaceModel({
        task: {
          id: "task-error",
          repoId: "repo-1",
          title: "Reconnect the terminal",
          stage: "in progress"
        },
        terminalStatus: "error",
        terminalErrorMessage: null
      }).overlayLabel
    ).toBe("Error");
  });

  it("shows a dedicated restarting state while the server replaces a missing session", () => {
    expect(
      buildTaskWorkspaceModel({
        task: {
          id: "task-restarting",
          repoId: "repo-1",
          title: "Recover the agent",
          stage: "in progress"
        },
        terminalStatus: "restarting"
      })
    ).toMatchObject({
      isTerminalHealthy: false,
      overlayLabel: "Restarting session",
      isComposerDisabled: true
    });
  });

  it.each([
    ["pending", "Creating task", false],
    ["recovering", "Recovering task", false],
    ["uncertain", "Task creation interrupted", true]
  ] as const)(
    "maps %s optimistic creation into the task workspace",
    (taskCreationPhase, overlayLabel, canRecoverTaskCreation) => {
      expect(
        buildTaskWorkspaceModel({
          task: {
            id: "create:slot-1",
            repoId: "repo-1",
            title: "Create this task",
            stage: "in progress",
            agentType: "pty"
          },
          terminalStatus: "idle",
          taskCreationPhase
        })
      ).toMatchObject({
        isTerminalHealthy: false,
        overlayLabel,
        isComposerDisabled: true,
        canRecoverTaskCreation
      });
    }
  );
});
