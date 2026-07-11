import { describe, expect, it } from "vitest";
import { selectTaskByActivity, type SelectableTask } from "./selectTaskByActivity";

function makeTask(
  id: string,
  createdAt: string,
  activity: SelectableTask["activity"],
): SelectableTask & { id: string } {
  return {
    id,
    created_at: createdAt,
    activity,
  };
}

describe("selectTaskByActivity", () => {
  const tasks = [
    makeTask("idle-old", "2026-03-31T00:00:00.000Z", "idle"),
    makeTask("unread-oldest", "2026-03-31T01:00:00.000Z", "unread"),
    makeTask("unread-near-older", "2026-03-31T01:30:00.000Z", "unread"),
    makeTask("working-mid", "2026-03-31T02:00:00.000Z", "working"),
    makeTask("idle-new", "2026-03-31T02:30:00.000Z", "idle"),
    makeTask("unread-near-newer", "2026-03-31T03:00:00.000Z", "unread"),
    makeTask("unread-newest", "2026-03-31T04:00:00.000Z", "unread"),
  ];

  it("selects oldest unread task by created_at when unread_at is unavailable", () => {
    expect(selectTaskByActivity(tasks, "oldest", "unread")?.id).toBe("unread-oldest");
  });

  it("selects newest unread task by created_at when unread_at is unavailable", () => {
    expect(selectTaskByActivity(tasks, "newest", "unread")?.id).toBe("unread-newest");
  });

  it("orders unread tasks by created_at even when unread_at differs", () => {
    const unreadTasks = [
      {
        ...makeTask("created-oldest-unread-newest", "2026-03-31T00:00:00.000Z", "unread"),
        unread_at: "2026-03-31T04:00:00.000Z",
      },
      {
        ...makeTask("created-newest-unread-oldest", "2026-03-31T03:00:00.000Z", "unread"),
        unread_at: "2026-03-31T01:00:00.000Z",
      },
      {
        ...makeTask("created-middle-unread-middle", "2026-03-31T02:00:00.000Z", "unread"),
        unread_at: "2026-03-31T02:00:00.000Z",
      },
    ];

    expect(selectTaskByActivity(unreadTasks, "oldest", "unread")?.id).toBe("created-oldest-unread-newest");
    expect(selectTaskByActivity(unreadTasks, "newest", "unread")?.id).toBe("created-newest-unread-oldest");
  });

  it("selects idle tasks for read shortcut navigation", () => {
    expect(selectTaskByActivity(tasks, "oldest", "idle")?.id).toBe("idle-old");
    expect(selectTaskByActivity(tasks, "newest", "idle")?.id).toBe("idle-new");
  });

  it("can select working tasks without mixing them into idle shortcuts", () => {
    expect(selectTaskByActivity(tasks, "newest", "working")?.id).toBe("working-mid");
  });

  it("returns null when there is no matching task", () => {
    expect(
      selectTaskByActivity(
        [makeTask("only-unread", "2026-03-31T01:00:00.000Z", "unread")],
        "oldest",
        "idle",
      ),
    ).toBeNull();
    expect(selectTaskByActivity([], "newest", "unread")).toBeNull();
  });
});
