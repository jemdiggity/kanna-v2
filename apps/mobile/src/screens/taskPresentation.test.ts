import { describe, expect, it } from "vitest";
import {
  buildTaskListItemModel,
  buildTaskWorkspaceHeaderModel
} from "./taskPresentation";

describe("buildTaskListItemModel", () => {
  it("prefers repo names and trims snippets for task cards", () => {
    const model = buildTaskListItemModel(
      {
        id: "task-1",
        repoId: "repo-1",
        title: "Refactor mobile task cards",
        stage: "in progress",
        snippet: "  Recent output line  "
      },
      "kanna-tauri",
      false
    );

    expect(model.repoLabel).toBe("kanna-tauri");
    expect(model.stageLabel).toBe("in progress");
    expect(model.preview).toBe("Recent output line");
    expect(model.scopeLabel).toBe("Task");
  });

  it("falls back cleanly for recent tasks without snippets", () => {
    const model = buildTaskListItemModel(
      {
        id: "task-2",
        repoId: "repo-2",
        title: "Review task output",
        stage: "pr"
      },
      null,
      true
    );

    expect(model.repoLabel).toBe("repo-2");
    expect(model.scopeLabel).toBe("Recent");
    expect(model.preview).toBe("Ready for review.");
  });

  it("uses shorter generic preview copy for active work", () => {
    const model = buildTaskListItemModel(
      {
        id: "task-3",
        repoId: "repo-3",
        title: "Wire up task refresh",
        stage: "in progress"
      },
      "repo-three",
      false
    );

    expect(model.preview).toBe("Open the task for the latest output.");
  });

  it("does not treat legacy merge stage as a separate lifecycle state", () => {
    const model = buildTaskListItemModel(
      {
        id: "task-merge",
        repoId: "repo-1",
        title: "Merge Master",
        stage: "merge"
      },
      "repo-one",
      false
    );

    expect(model.preview).toBe("Open the task for the latest output.");
  });
});

describe("buildTaskWorkspaceHeaderModel", () => {
  it("builds task workspace header copy for an active task", () => {
    const model = buildTaskWorkspaceHeaderModel({
      desktopName: "Studio Mac",
      repoName: "kanna-tauri",
      task: {
        id: "task-9",
        repoId: "repo-1",
        title: "Tighten mobile workspace",
        stage: "pr",
        snippet: "Latest agent output"
      }
    });

    expect(model.desktopLabel).toBe("Studio Mac");
    expect(model.repoLabel).toBe("kanna-tauri");
    expect(model.stageLabel).toBe("pr");
    expect(model.snippetLabel).toBe("Latest agent output");
  });
});
