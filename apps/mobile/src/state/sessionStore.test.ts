import { describe, expect, it } from "vitest";
import { createSessionStore } from "./sessionStore";

describe("createSessionStore", () => {
  it("switches the selected desktop without dropping the desktop list", () => {
    const store = createSessionStore();
    store.setDesktops([
      { id: "desktop-a", name: "Studio Mac", online: true, mode: "lan" },
      { id: "desktop-b", name: "Laptop", online: false, mode: "remote" }
    ]);

    store.selectDesktop("desktop-b");

    expect(store.getState().selectedDesktopId).toBe("desktop-b");
    expect(store.getState().desktops).toHaveLength(2);
  });

  it("selects the first desktop when no desktop is selected", () => {
    const store = createSessionStore();
    store.setDesktops([
      { id: "desktop-a", name: "Studio Mac", online: true, mode: "lan" }
    ]);

    expect(store.getState().selectedDesktopId).toBe("desktop-a");
  });

  it("does not clear the selected task during a partial collection update", () => {
    const store = createSessionStore();

    store.setRepoTasks([
      {
        id: "task-1",
        repoId: "repo-1",
        title: "Keep selected task",
        stage: "in progress"
      }
    ]);
    store.setSelectedTask("task-1");
    store.beginTaskTerminal("task-1", "Existing output");
    store.setTaskTerminalStatus("task-1", "live");

    store.setRecentTasks([]);

    expect(store.getState()).toMatchObject({
      selectedTaskId: "task-1",
      taskTerminalTaskId: "task-1",
      taskTerminalStatus: "live",
      taskTerminalOutput: "Existing output"
    });
  });

  it("retags an active terminal without losing buffered state", () => {
    const store = createSessionStore();

    store.setSelectedTask("task-pending");
    store.beginTaskTerminal("task-pending", "snapshot\n");
    store.appendTaskTerminal("task-pending", "delta\n");
    store.setTaskTerminalDims("task-pending", 132, 43);

    store.retagTaskIdentity("task-pending", "task-published");

    expect(store.getState()).toMatchObject({
      selectedTaskId: "task-published",
      taskTerminalTaskId: "task-published",
      taskTerminalStatus: "live",
      taskTerminalOutput: "snapshot\ndelta\n",
      taskTerminalCols: 132,
      taskTerminalRows: 43
    });
  });

  it("retags an active agent without losing buffered events", () => {
    const store = createSessionStore();

    store.setSelectedTask("task-pending");
    store.beginTaskAgent("task-pending");
    store.applyTaskAgentStreamEvent("task-pending", {
      type: "snapshot",
      events: [{
        seq: 0,
        event: { type: "assistant_text", text: "Buffered", truncated: false }
      }]
    });

    store.retagTaskIdentity("task-pending", "task-published");

    expect(store.getState()).toMatchObject({
      selectedTaskId: "task-published",
      taskAgentTaskId: "task-published",
      taskAgentStatus: "live",
      taskAgentEvents: [{
        seq: 0,
        event: { type: "assistant_text", text: "Buffered", truncated: false }
      }]
    });
  });

  it("clears the selected task when reconciliation finds no remaining collection match", () => {
    const store = createSessionStore();

    store.setRepoTasks([
      {
        id: "task-1",
        repoId: "repo-1",
        title: "Clear selected task",
        stage: "in progress"
      }
    ]);
    store.setSelectedTask("task-1");
    store.beginTaskTerminal("task-1", "Existing output");
    store.setTaskTerminalStatus("task-1", "live");
    store.setRepoTasks([]);

    store.reconcileSelectedTask();

    expect(store.getState()).toMatchObject({
      selectedTaskId: null,
      taskTerminalTaskId: null,
      taskTerminalStatus: "idle",
      taskTerminalOutput: ""
    });
  });

  it("preserves terminal stream error messages on the active terminal only", () => {
    const store = createSessionStore();

    store.beginTaskTerminal("task-1", "Existing output");
    store.setTaskTerminalError("task-1", "No terminal session is available for this task");
    store.setTaskTerminalError("task-2", "Desktop offline");

    expect(store.getState()).toMatchObject({
      taskTerminalTaskId: "task-1",
      taskTerminalStatus: "error",
      taskTerminalErrorMessage: "No terminal session is available for this task",
      taskTerminalOutput: "Existing output"
    });

    store.clearTaskTerminal();

    expect(store.getState()).toMatchObject({
      taskTerminalTaskId: null,
      taskTerminalStatus: "idle",
      taskTerminalErrorMessage: null,
      taskTerminalOutput: ""
    });
  });

  it("keeps a large base64 snapshot frame intact instead of slicing mid-token", () => {
    const store = createSessionStore();
    store.beginTaskTerminal("task-1", "");

    // A real TUI snapshot is a single base64 frame far larger than the old
    // 12000-char cap. Char-slicing it corrupted base64 -> blank terminal.
    const snapshot = "A".repeat(50_000);
    store.appendTaskTerminal("task-1", `${snapshot}\n`);

    expect(store.getState().taskTerminalOutput).toBe(`${snapshot}\n`);
  });

  it("drops whole oldest base64 frames (never a partial token) when over the cap", () => {
    const store = createSessionStore();
    store.beginTaskTerminal("task-1", "");

    const frame = "B".repeat(300_000);
    for (let i = 0; i < 5; i += 1) {
      store.appendTaskTerminal("task-1", `${frame}\n`);
    }

    const output = store.getState().taskTerminalOutput;
    const frames = output.split("\n").filter((segment) => segment.length > 0);
    // Every retained frame is intact; none truncated mid-base64.
    expect(frames.every((segment) => segment === frame)).toBe(true);
    expect(output.length).toBeLessThanOrEqual(1_000_001);
  });

  it("keeps a large snapshot plus live frames decodable through the accumulation cap", () => {
    const store = createSessionStore();
    store.beginTaskTerminal("task-1", "");
    store.setTaskTerminalDims("task-1", 220, 72);

    const snapshotText = Array.from({ length: 72 }, (_value, index) =>
      `row ${String(index + 1).padStart(2, "0")} ${"snapshot ".repeat(22)}`
    ).join("\r\n");
    const snapshotFrame = Buffer.from(snapshotText, "utf8").toString("base64");
    const liveFrame = Buffer.from("LIVE-APPEND-CORRECT", "utf8").toString("base64");

    store.appendTaskTerminal("task-1", `${snapshotFrame}\n`);
    store.appendTaskTerminal("task-1", `${liveFrame}\n`);

    const state = store.getState();
    const frames = state.taskTerminalOutput.split("\n").filter(Boolean);
    const decoded = frames.map((frame) => Buffer.from(frame, "base64").toString("utf8")).join("");

    expect(state.taskTerminalCols).toBe(220);
    expect(state.taskTerminalRows).toBe(72);
    expect(frames).toEqual([snapshotFrame, liveFrame]);
    expect(decoded).toContain("row 72");
    expect(decoded).toContain("LIVE-APPEND-CORRECT");
  });

  it("does not publish when repo tasks are refreshed with identical data", () => {
    const store = createSessionStore();
    let publishes = 0;
    store.subscribe(() => {
      publishes += 1;
    });

    store.setRepoTasks([
      {
        id: "task-1",
        repoId: "repo-1",
        title: "Keep scroll position",
        stage: "in progress",
        waitingPromptSnippet: "latest output"
      }
    ]);
    publishes = 0;

    store.setRepoTasks([
      {
        id: "task-1",
        repoId: "repo-1",
        title: "Keep scroll position",
        stage: "in progress",
        waitingPromptSnippet: "latest output"
      }
    ]);

    expect(publishes).toBe(0);
  });

  it("does not publish when recent tasks are refreshed with identical data", () => {
    const store = createSessionStore();
    let publishes = 0;
    store.subscribe(() => {
      publishes += 1;
    });

    store.setRecentTasks([
      {
        id: "task-2",
        repoId: "repo-2",
        title: "Recent task",
        stage: "pr",
        waitingPromptSnippet: "ready for review"
      }
    ]);
    publishes = 0;

    store.setRecentTasks([
      {
        id: "task-2",
        repoId: "repo-2",
        title: "Recent task",
        stage: "pr",
        waitingPromptSnippet: "ready for review"
      }
    ]);

    expect(publishes).toBe(0);
  });

  it("publishes when only a task's activity changes", () => {
    const store = createSessionStore();
    let publishes = 0;
    store.subscribe(() => {
      publishes += 1;
    });

    store.setRecentTasks([
      {
        id: "task-2",
        repoId: "repo-2",
        title: "Recent task",
        stage: "pr",
        snippet: "ready for review",
        activity: "idle"
      }
    ]);
    publishes = 0;

    store.setRecentTasks([
      {
        id: "task-2",
        repoId: "repo-2",
        title: "Recent task",
        stage: "pr",
        snippet: "ready for review",
        activity: "working"
      }
    ]);

    expect(publishes).toBe(1);
    expect(store.getState().recentTasks[0]?.activity).toBe("working");
  });

  it("does not publish when missing task activity is refreshed as idle", () => {
    const store = createSessionStore();
    let publishes = 0;
    store.subscribe(() => {
      publishes += 1;
    });

    store.setRepoTasks([
      {
        id: "task-1",
        repoId: "repo-1",
        title: "Keep scroll position",
        stage: "in progress",
        snippet: "latest output"
      }
    ]);
    publishes = 0;

    store.setRepoTasks([
      {
        id: "task-1",
        repoId: "repo-1",
        title: "Keep scroll position",
        stage: "in progress",
        snippet: "latest output",
        activity: "idle"
      }
    ]);

    expect(publishes).toBe(0);
  });

  it("updates a task activity across every collection with one publication", () => {
    const store = createSessionStore();
    const unreadTask = {
      id: "task-activity",
      repoId: "repo-1",
      title: "Read this task",
      stage: "in progress",
      activity: "unread" as const
    };
    store.setRepoTasks([unreadTask]);
    store.setRecentTasks([unreadTask]);
    store.setSearchResults("read", [unreadTask]);
    let publishes = 0;
    store.subscribe(() => {
      publishes += 1;
    });

    store.setTaskActivity("task-activity", "idle");

    expect(publishes).toBe(1);
    expect(store.getState().repoTasks[0]?.activity).toBe("idle");
    expect(store.getState().recentTasks[0]?.activity).toBe("idle");
    expect(store.getState().searchResults[0]?.activity).toBe("idle");
  });

  it("deduplicates task lists by id before publishing state", () => {
    const store = createSessionStore();
    const task = {
      id: "cloud:desktop-1:repo-1:task-1",
      repoId: "repo-1",
      title: "foobar",
      stage: "in progress"
    };

    store.setRecentTasks([task, { ...task }]);
    store.setRepoTasks([task, { ...task }, { ...task }]);
    store.setSearchResults("foobar", [task, { ...task }]);

    expect(store.getState().recentTasks.map((item) => item.id)).toEqual([task.id]);
    expect(store.getState().repoTasks.map((item) => item.id)).toEqual([task.id]);
    expect(store.getState().searchResults.map((item) => item.id)).toEqual([task.id]);
  });

  it("persists the signed-in auth user snapshot for reload", () => {
    const store = createSessionStore();

    store.setAuthState({
      status: "signedIn",
      user: {
        uid: "user-1",
        email: "dev@kanna.test",
        displayName: "Dev"
      }
    });

    expect(store.getPersistedContext().authUser).toEqual({
      uid: "user-1",
      email: "dev@kanna.test",
      displayName: "Dev"
    });
  });

  it("hydrates a persisted auth user as signed in context", () => {
    const store = createSessionStore();

    store.hydrateContext({
      selectedDesktopId: null,
      selectedRepoId: null,
      selectedTaskId: null,
      activeView: "tasks",
      authUser: {
        uid: "user-1",
        email: "dev@kanna.test",
        displayName: null
      }
    });

    expect(store.getState().auth).toEqual({
      status: "signedIn",
      user: {
        uid: "user-1",
        email: "dev@kanna.test",
        displayName: null
      }
    });
  });

  it("hydrates and persists repo creation profiles", () => {
    const store = createSessionStore();

    store.hydrateContext({
      selectedDesktopId: "desktop-1",
      selectedRepoId: "repo-1",
      selectedTaskId: null,
      activeView: "tasks",
      repoCreationProfiles: [
        {
          repoId: "repo-1",
          desktopId: "desktop-1",
          agentProvider: "claude",
          updatedAt: "2026-07-06T00:00:00.000Z"
        }
      ]
    });

    expect(store.getState().repoCreationProfiles).toEqual([
      {
        repoId: "repo-1",
        desktopId: "desktop-1",
        agentProvider: "claude",
        updatedAt: "2026-07-06T00:00:00.000Z"
      }
    ]);
    expect(store.getPersistedContext().repoCreationProfiles).toEqual(
      store.getState().repoCreationProfiles
    );
  });

  it("upserts repo creation profiles by repo id", () => {
    const store = createSessionStore();

    store.upsertRepoCreationProfile({
      repoId: "repo-1",
      desktopId: "desktop-1",
      agentProvider: "claude",
      updatedAt: "2026-07-06T00:00:00.000Z"
    });
    store.upsertRepoCreationProfile({
      repoId: "repo-1",
      desktopId: "desktop-2",
      agentProvider: "copilot",
      updatedAt: "2026-07-06T01:00:00.000Z"
    });

    expect(store.getState().repoCreationProfiles).toEqual([
      {
        repoId: "repo-1",
        desktopId: "desktop-2",
        agentProvider: "copilot",
        updatedAt: "2026-07-06T01:00:00.000Z"
      }
    ]);
  });
});
