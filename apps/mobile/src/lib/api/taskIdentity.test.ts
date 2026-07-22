import { describe, expect, it } from "vitest";
import type { TaskSummary } from "./types";
import {
  isTaskBlocked,
  resolveBlockerTasks,
  sameTaskDesktop,
  taskLocalId
} from "./taskIdentity";

function task(overrides: Partial<TaskSummary> & { id: string }): TaskSummary {
  return {
    repoId: "repo-1",
    title: `Task ${overrides.id}`,
    stage: "in progress",
    ...overrides
  };
}

describe("taskLocalId", () => {
  it("prefers the owner-local id over the display id", () => {
    expect(taskLocalId(task({ id: "cloud-1", ownerLocalTaskId: "local-1" }))).toBe(
      "local-1"
    );
    expect(taskLocalId(task({ id: "local-1" }))).toBe("local-1");
  });
});

describe("sameTaskDesktop", () => {
  it("treats an undefined owner as matching any desktop", () => {
    expect(
      sameTaskDesktop(task({ id: "a" }), task({ id: "b", ownerDesktopId: "d1" }))
    ).toBe(true);
    expect(
      sameTaskDesktop(
        task({ id: "a", ownerDesktopId: "d1" }),
        task({ id: "b", ownerDesktopId: "d2" })
      )
    ).toBe(false);
  });
});

describe("isTaskBlocked", () => {
  it("is blocked only while unresolved blocker ids remain", () => {
    expect(isTaskBlocked(task({ id: "a" }))).toBe(false);
    expect(isTaskBlocked(task({ id: "a", blockedByTaskIds: [] }))).toBe(false);
    expect(isTaskBlocked(task({ id: "a", blockedByTaskIds: ["b"] }))).toBe(true);
  });
});

describe("resolveBlockerTasks", () => {
  it("resolves blockers by owner-local id across repos on the same desktop", () => {
    const blocked = task({
      id: "kd-task",
      repoId: "repo-kanna",
      ownerDesktopId: "d1",
      blockedByTaskIds: ["kanache-task", "missing-task"]
    });
    const blocker = task({
      id: "cloud-kanache-task",
      repoId: "repo-kanache",
      ownerDesktopId: "d1",
      ownerLocalTaskId: "kanache-task",
      title: "Rust-input-hash donor matching"
    });
    const otherDesktop = task({
      id: "missing-task",
      ownerDesktopId: "d2"
    });

    expect(resolveBlockerTasks(blocked, [blocked, blocker, otherDesktop])).toEqual([
      { blockerTaskId: "kanache-task", task: blocker },
      { blockerTaskId: "missing-task", task: null }
    ]);
  });

  it("returns empty for a task with no blockers", () => {
    expect(resolveBlockerTasks(task({ id: "a" }), [])).toEqual([]);
  });
});
