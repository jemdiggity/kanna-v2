import { describe, expect, it } from "vitest";
import { createSessionStore } from "./sessionStore";
import { buildCreatingTaskUiSlot } from "./taskUiSlots";

describe("createSessionStore", () => {
  const pendingTaskCreation = {
    slotId: "create:slot-a1b2c3d4",
    taskId: "a1b2c3d4",
    repoId: "repo-1",
    prompt: "Add durable mobile task recovery",
    desktopId: "desktop-e2e",
    agentProvider: "codex" as const
  };

  it("starts with an idle task creation state and no composer repo", () => {
    const store = createSessionStore();

    expect(store.getState()).toMatchObject({
      composerRepoId: null,
      pendingTaskCreation: null,
      taskUiSlots: [],
      taskCreationPhase: "idle"
    });
  });

  it("owns the local task slot lifecycle independently from task identity", () => {
    const store = createSessionStore();
    const slot = buildCreatingTaskUiSlot({
      slotId: pendingTaskCreation.slotId,
      repoId: pendingTaskCreation.repoId,
      prompt: pendingTaskCreation.prompt,
      desktopId: pendingTaskCreation.desktopId,
      agentProvider: pendingTaskCreation.agentProvider
    });

    store.addTaskUiSlot(slot);
    store.acknowledgeTaskUiSlot(slot.slotId, {
      id: "cloud:desktop-e2e:repo-1:a1b2c3d4",
      repoId: pendingTaskCreation.repoId,
      title: pendingTaskCreation.prompt,
      stage: "in progress",
      agentType: "pty"
    });

    expect(store.getState().taskUiSlots).toEqual([
      expect.objectContaining({
        slotId: pendingTaskCreation.slotId,
        taskId: "cloud:desktop-e2e:repo-1:a1b2c3d4",
        state: "ready"
      })
    ]);

    store.removeTaskUiSlot(slot.slotId);
    expect(store.getState().taskUiSlots).toEqual([]);
  });

  it("reconciles acknowledged local slots against authoritative collections", () => {
    const store = createSessionStore();
    const slot = buildCreatingTaskUiSlot({
      slotId: pendingTaskCreation.slotId,
      repoId: pendingTaskCreation.repoId,
      prompt: pendingTaskCreation.prompt,
      desktopId: pendingTaskCreation.desktopId,
      agentProvider: pendingTaskCreation.agentProvider
    });
    const createdTask = {
      id: "cloud:desktop-e2e:repo-1:a1b2c3d4",
      repoId: pendingTaskCreation.repoId,
      title: pendingTaskCreation.prompt,
      stage: "in progress"
    };

    store.addTaskUiSlot(slot);
    store.acknowledgeTaskUiSlot(slot.slotId, createdTask);
    store.reconcileTaskUiSlots([], { authoritative: true });

    expect(store.getState().taskUiSlots).toEqual([
      expect.objectContaining({ authoritativeMissGraceRemaining: 0 })
    ]);

    const publishedTask = { ...createdTask, title: "Published task" };
    store.reconcileTaskUiSlots([publishedTask], { authoritative: true });

    expect(store.getState().taskUiSlots).toEqual([
      expect.objectContaining({
        slotId: slot.slotId,
        task: publishedTask,
        authoritativeMissGraceRemaining: 0
      })
    ]);
  });

  it("sets a pending task creation attempt and phase atomically", () => {
    const store = createSessionStore();

    store.setTaskCreationState({
      phase: "pending",
      pendingTaskCreation
    });

    expect(store.getState()).toMatchObject({
      pendingTaskCreation,
      taskCreationPhase: "pending"
    });
  });

  it("closing the composer does not cancel or downgrade pending creation", () => {
    const store = createSessionStore();
    store.setComposerState(true, pendingTaskCreation.prompt);
    store.setTaskCreationState({
      phase: "recovering",
      pendingTaskCreation
    });

    store.setComposerState(false, pendingTaskCreation.prompt);

    expect(store.getState()).toMatchObject({
      isComposerOpen: false,
      pendingTaskCreation,
      taskCreationPhase: "recovering"
    });
  });

  it("clears an attempt without clearing the composer draft mirrors", () => {
    const store = createSessionStore();
    store.setComposerState(true, pendingTaskCreation.prompt);
    store.setComposerRepo(pendingTaskCreation.repoId);
    store.setComposerDesktop(pendingTaskCreation.desktopId);
    store.setComposerAgentProvider(pendingTaskCreation.agentProvider);
    store.setTaskCreationState({
      phase: "uncertain",
      pendingTaskCreation
    });

    store.setTaskCreationState({
      phase: "idle",
      pendingTaskCreation: null
    });

    expect(store.getState()).toMatchObject({
      composerRepoId: pendingTaskCreation.repoId,
      composerPrompt: pendingTaskCreation.prompt,
      composerDesktopId: pendingTaskCreation.desktopId,
      composerAgentProvider: pendingTaskCreation.agentProvider,
      pendingTaskCreation: null,
      taskCreationPhase: "idle"
    });
  });

  it("hydrates a pending attempt as closed and uncertain with its draft restored", () => {
    const store = createSessionStore();
    store.setComposerState(true, "Stale draft");

    store.hydrateContext({
      selectedDesktopId: "desktop-e2e",
      selectedRepoId: "repo-1",
      selectedTaskId: null,
      activeView: "tasks",
      pendingTaskCreation
    });

    expect(store.getState()).toMatchObject({
      isComposerOpen: false,
      composerRepoId: pendingTaskCreation.repoId,
      composerPrompt: pendingTaskCreation.prompt,
      composerDesktopId: pendingTaskCreation.desktopId,
      composerAgentProvider: pendingTaskCreation.agentProvider,
      pendingTaskCreation,
      taskUiSlots: [
        {
          slotId: pendingTaskCreation.slotId,
          taskId: null,
          state: "creating"
        }
      ],
      taskCreationPhase: "uncertain"
    });
  });

  it("persists only the pending attempt from task creation state", () => {
    const store = createSessionStore();
    store.setComposerState(true, pendingTaskCreation.prompt);
    store.setComposerRepo(pendingTaskCreation.repoId);
    store.setTaskCreationState({
      phase: "recovering",
      pendingTaskCreation
    });

    const persisted = store.getPersistedContext();

    expect(persisted.pendingTaskCreation).toEqual(pendingTaskCreation);
    expect(persisted).not.toHaveProperty("taskCreationPhase");
    expect(persisted).not.toHaveProperty("isComposerOpen");
    expect(persisted).not.toHaveProperty("composerPrompt");
    expect(persisted).not.toHaveProperty("composerRepoId");
  });

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
    const snapshot = "A".repeat(1_050_000);
    store.appendTaskTerminal("task-1", `${snapshot}\n`);

    expect(store.getState().taskTerminalOutput).toBe(`${snapshot}\n`);
  });

  it("replaces stale output atomically when an authoritative snapshot arrives", () => {
    const store = createSessionStore();
    store.beginTaskTerminal("task-1", "");
    store.appendTaskTerminal("task-1", "stale-frame\n");
    const previousEpoch = store.getState().taskTerminalOutputEpoch;
    let publishes = 0;
    store.subscribe(() => {
      publishes += 1;
    });

    store.replaceTaskTerminalSnapshot("task-1", "fresh-snapshot", 132, 43);

    expect(store.getState()).toMatchObject({
      taskTerminalStatus: "live",
      taskTerminalOutput: "fresh-snapshot\n",
      taskTerminalOutputEpoch: previousEpoch + 1,
      taskTerminalOutputStart: 0,
      taskTerminalCols: 132,
      taskTerminalRows: 43,
      taskTerminalErrorMessage: null
    });
    expect(publishes).toBe(1);
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
    expect(store.getState().taskTerminalOutputStart).toBe(600_002);
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

  it("publishes when a task creation time is learned", () => {
    const store = createSessionStore();
    let publishes = 0;
    store.subscribe(() => {
      publishes += 1;
    });

    store.setRepoTasks([
      {
        id: "task-1",
        repoId: "repo-1",
        title: "New task",
        stage: "in progress"
      }
    ]);
    publishes = 0;

    store.setRepoTasks([
      {
        id: "task-1",
        repoId: "repo-1",
        title: "New task",
        stage: "in progress",
        createdAt: "2026-07-17T08:00:00.000Z"
      }
    ]);

    expect(publishes).toBe(1);
    expect(store.getState().repoTasks[0]?.createdAt).toBe(
      "2026-07-17T08:00:00.000Z"
    );
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
        waitingPromptSnippet: "ready for review",
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
        waitingPromptSnippet: "ready for review",
        activity: "working"
      }
    ]);

    expect(publishes).toBe(1);
    expect(store.getState().recentTasks[0]?.activity).toBe("working");
  });

  it("publishes when a task's canonical prompt changes without a title change", () => {
    const store = createSessionStore();
    let publishes = 0;
    store.subscribe(() => {
      publishes += 1;
    });

    store.setRecentTasks([
      {
        id: "task-2",
        repoId: "repo-2",
        title: "Short renamed task",
        prompt: "Older prompt",
        stage: "pr"
      }
    ]);
    publishes = 0;

    store.setRecentTasks([
      {
        id: "task-2",
        repoId: "repo-2",
        title: "Short renamed task",
        prompt: "Updated prompt\nPROMPT_END_SENTINEL",
        stage: "pr"
      }
    ]);

    expect(publishes).toBe(1);
    expect(store.getState().recentTasks[0]?.prompt).toBe(
      "Updated prompt\nPROMPT_END_SENTINEL"
    );
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
        waitingPromptSnippet: "latest output",
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
