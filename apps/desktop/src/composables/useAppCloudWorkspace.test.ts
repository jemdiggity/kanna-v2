import { describe, expect, it } from "vitest";

import { hasLocalTaskSelectionIdentity } from "./useAppCloudWorkspace";

describe("hasLocalTaskSelectionIdentity", () => {
  it("gives a selected initializer ownership over stale remote selection state", () => {
    expect(hasLocalTaskSelectionIdentity({
      selectedRepoId: "repo-1",
      selectedItemId: "create:task",
      items: [],
      initializingTaskItems: [{ id: "create:task", repo_id: "repo-1" }],
    })).toBe(true);
  });

  it("keeps ownership after the initializer hands off to its durable local task", () => {
    expect(hasLocalTaskSelectionIdentity({
      selectedRepoId: "repo-1",
      selectedItemId: "task-durable",
      items: [{ id: "task-durable", repo_id: "repo-1" }],
      initializingTaskItems: [],
    })).toBe(true);
  });

  it("does not claim a remote workspace projection as local", () => {
    expect(hasLocalTaskSelectionIdentity({
      selectedRepoId: "repo-1",
      selectedItemId: "cloud:repo-1:task-remote",
      items: [{ id: "task-local", repo_id: "repo-1" }],
      initializingTaskItems: [],
    })).toBe(false);
  });
});
