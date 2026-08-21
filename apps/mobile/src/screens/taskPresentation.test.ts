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

  it("uses the first nonblank prompt line when the stored title is blank", () => {
    const model = buildTaskListItemModel({
      id: "current-task-id",
      repoId: "repo-1",
      title: "  ",
      prompt: "\n  A humane prompt excerpt  \nMore detail",
      stage: "pr"
    });

    expect(model.title).toBe("A humane prompt excerpt");
  });

  it("uses a humane generic label when both title and prompt are blank", () => {
    const model = buildTaskListItemModel({
      id: "current-task-id",
      repoId: "repo-1",
      title: "",
      prompt: " ",
      stage: "pr"
    });

    expect(model.title).toBe("Untitled task");
    expect(model.title).not.toContain("current-task-id");
  });

  it("hides a short waiting prompt that duplicates the title", () => {
    const model = buildTaskListItemModel({
      id: "task-short-duplicate",
      repoId: "repo-1",
      title: "Fix the duplicated mobile task prompt",
      stage: "in progress",
      waitingPromptSnippet: "Fix the duplicated mobile task prompt"
    });

    expect(model.waitingPromptSnippet).toBeNull();
    expect(model.isWaitingPromptPlaceholder).toBe(false);
  });

  it("hides the daemon-normalized preview of a multiline title", () => {
    const model = buildTaskListItemModel({
      id: "task-whitespace-duplicate",
      repoId: "repo-1",
      title: "Fix the duplicated\n  mobile\u0085 task prompt",
      stage: "in progress",
      waitingPromptSnippet: "Fix the duplicated mobile task prompt"
    });

    expect(model.waitingPromptSnippet).toBeNull();
    expect(model.isWaitingPromptPlaceholder).toBe(false);
  });

  it("hides the daemon-bounded preview of a long title", () => {
    const longTitle = `${"😀".repeat(239)}\nadditional prompt text`;
    const boundedWaitingPreview = `${"😀".repeat(239)}…`;
    const model = buildTaskListItemModel({
      id: "task-long-duplicate",
      repoId: "repo-1",
      title: longTitle,
      stage: "in progress",
      waitingPromptSnippet: boundedWaitingPreview
    });

    expect(model.waitingPromptSnippet).toBeNull();
    expect(model.isWaitingPromptPlaceholder).toBe(false);
  });

  it("keeps a similar but distinct waiting preview visible", () => {
    const model = buildTaskListItemModel({
      id: "task-distinct-preview",
      repoId: "repo-1",
      title: "Fix the duplicated mobile task prompt",
      stage: "in progress",
      waitingPromptSnippet: "Fixed the duplicated mobile task prompt"
    });

    expect(model.waitingPromptSnippet).toBe(
      "Fixed the duplicated mobile task prompt"
    );
    expect(model.isWaitingPromptPlaceholder).toBe(false);
  });

  it("does not treat ECMAScript-only trim characters as daemon whitespace", () => {
    const model = buildTaskListItemModel({
      id: "task-byte-order-mark",
      repoId: "repo-1",
      title: "\uFEFFFix the duplicated mobile task prompt",
      stage: "in progress",
      waitingPromptSnippet: "Fix the duplicated mobile task prompt"
    });

    expect(model.waitingPromptSnippet).toBe(
      "Fix the duplicated mobile task prompt"
    );
    expect(model.isWaitingPromptPlaceholder).toBe(false);
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
