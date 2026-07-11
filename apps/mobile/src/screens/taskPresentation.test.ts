import { describe, expect, it } from "vitest";
import { buildTaskListItemModel } from "./taskPresentation";

describe("buildTaskListItemModel", () => {
  it("shows the current title and waiting prompt", () => {
    const model = buildTaskListItemModel({
      id: "task-1",
      repoId: "repo-1",
      title: "Current editable title",
      stage: "in progress",
      waitingPromptSnippet: "Ready for review"
    });

    expect(model).toEqual({
      stageLabel: "in progress",
      title: "Current editable title",
      waitingPromptSnippet: "Ready for review",
      isWaitingPromptPlaceholder: false
    });
  });

  it("uses a muted ellipsis before the first waiting prompt", () => {
    const model = buildTaskListItemModel({
      id: "task-2",
      repoId: "repo-1",
      title: "New task",
      stage: "in progress"
    });

    expect(model.waitingPromptSnippet).toBe("…");
    expect(model.isWaitingPromptPlaceholder).toBe(true);
  });

  it("bounds title and prompt including the ellipsis without splitting surrogates", () => {
    const model = buildTaskListItemModel({
      id: "task-3",
      repoId: "repo-1",
      title: "😀".repeat(81),
      stage: "review",
      waitingPromptSnippet: "界".repeat(241)
    });

    expect(Array.from(model.title)).toHaveLength(80);
    expect(model.title.endsWith("…")).toBe(true);
    expect(Array.from(model.waitingPromptSnippet)).toHaveLength(240);
    expect(model.waitingPromptSnippet.endsWith("…")).toBe(true);
  });
});
