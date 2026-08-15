import { describe, expect, it } from "vitest";
import type { TaskActivity, TaskSummary } from "../lib/api/types";
import {
  orderActivityTasks,
  unreadActivityCount,
  visibleActivityTasks
} from "./activityTaskOrder";

function task(id: string, activity?: TaskActivity | null): TaskSummary {
  return {
    id,
    repoId: "repo-1",
    title: id,
    stage: "in progress",
    ...(activity === undefined ? {} : { activity })
  };
}

describe("orderActivityTasks", () => {
  it("orders unread, idle/read, and working/busy groups", () => {
    const tasks = [
      task("working-1", "working"),
      task("idle-1", "idle"),
      task("unread-1", "unread"),
      task("working-2", "working"),
      task("missing"),
      task("unread-2", "unread"),
      task("idle-2", null)
    ];

    expect(orderActivityTasks(tasks).map(({ id }) => id)).toEqual([
      "unread-1",
      "unread-2",
      "idle-1",
      "missing",
      "idle-2",
      "working-1",
      "working-2"
    ]);
  });

  it("returns a reordered copy without mutating the source array", () => {
    const tasks = [task("working", "working"), task("unread", "unread")];

    const ordered = orderActivityTasks(tasks);

    expect(ordered).not.toBe(tasks);
    expect(tasks.map(({ id }) => id)).toEqual(["working", "unread"]);
  });

  it("projects and counts only unread notification entries", () => {
    const tasks = [
      task("working", "working"),
      task("unread-1", "unread"),
      task("idle", "idle"),
      task("unread-2", "unread")
    ];

    expect(visibleActivityTasks(tasks).map(({ id }) => id)).toEqual([
      "unread-1",
      "unread-2"
    ]);
    expect(unreadActivityCount(tasks)).toBe(2);
  });
});
