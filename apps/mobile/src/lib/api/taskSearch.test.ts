import { describe, expect, it } from "vitest";
import type { TaskSummary } from "./types";
import { taskMatchesSearchQuery } from "./taskSearch";

const task: TaskSummary = {
  id: "cloud:desktop-1:repo-1:eef65d54",
  ownerLocalTaskId: "eef65d54",
  repoId: "repo-1",
  title: "Unrelated title",
  prompt: "Unrelated prompt",
  stage: "in progress"
};

describe("taskMatchesSearchQuery", () => {
  it("matches the visible task id exactly or by a case-insensitive literal partial id", () => {
    expect(taskMatchesSearchQuery(task, "eef65d54")).toBe(true);
    expect(taskMatchesSearchQuery(task, "EEF65")).toBe(true);
    expect(taskMatchesSearchQuery(task, "65d5")).toBe(true);
    expect(taskMatchesSearchQuery(task, "ef54")).toBe(false);
  });

  it("preserves title and waiting-snippet matching", () => {
    expect(taskMatchesSearchQuery(task, "title")).toBe(true);
    expect(
      taskMatchesSearchQuery(
        { ...task, waitingPromptSnippet: "Needs owner response" },
        "OWNER"
      )
    ).toBe(true);
  });

  it("does not treat the synthetic cloud id as the owner-facing task id", () => {
    expect(taskMatchesSearchQuery(task, "desktop-1")).toBe(false);
  });

  it("preserves transport-level empty-query list semantics", () => {
    expect(taskMatchesSearchQuery(task, "   ")).toBe(true);
  });
});
