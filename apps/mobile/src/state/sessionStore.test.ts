import { describe, expect, it, vi } from "vitest";
import { createSessionStore } from "./sessionStore";
import { buildCreatingTaskUiSlot } from "./taskUiSlots";
import { terminalOutputToString } from "./terminalOutputBuffer";

function terminalText(store: ReturnType<typeof createSessionStore>): string {
  return terminalOutputToString(store.getState().taskTerminalOutput);
}

describe("createSessionStore", () => {
  const pendingTaskCreation = {
    slotId: "create:slot-a1b2c3d4",
    taskId: "a1b2c3d4",
    repoId: "repo-1",
    prompt: "Add durable mobile task recovery",
    desktopId: "desktop-e2e",
    agentProvider: "codex" as const
  };

  it("tracks task creation attempts independently by slot", () => {
    const store = createSessionStore();
    const secondAttempt = {
      ...pendingTaskCreation,
      slotId: "create:slot-b2c3d4e5",
      taskId: "b2c3d4e5",
      prompt: "Create another task"
    };

    store.addTaskCreationAttempt({
      ...pendingTaskCreation,
      phase: "pending"
    });
    store.addTaskCreationAttempt({
      ...secondAttempt,
      phase: "uncertain"
    });
    store.setTaskCreationAttemptPhase(pendingTaskCreation.slotId, "recovering");
    store.removeTaskCreationAttempt(secondAttempt.slotId);

    expect(store.getState().taskCreationAttempts).toEqual([
      {
        ...pendingTaskCreation,
        phase: "recovering",
        pendingAction: null,
        errorMessage: null
      }
    ]);
  });

  it("tracks first task collection readiness", () => {
    const store = createSessionStore();

    expect(store.getState().taskCollectionStatus).toBe("loading");

    store.setTaskCollectionStatus("ready");
    expect(store.getState().taskCollectionStatus).toBe("ready");

    store.setTaskCollectionStatus("error");
    expect(store.getState().taskCollectionStatus).toBe("error");
  });

  it("allows only one pending task action at a time", () => {
    const store = createSessionStore();

    expect(store.getState().pendingTaskAction).toBeNull();
    expect(store.beginTaskAction("task-1", "close-task")).toBe(true);
    expect(store.getState().pendingTaskAction).toEqual({
      taskId: "task-1",
      action: "close-task"
    });

    expect(store.beginTaskAction("task-1", "close-task")).toBe(false);
    expect(store.beginTaskAction("task-1", "advance-stage")).toBe(false);
    expect(store.beginTaskAction("task-2", "close-task")).toBe(false);

    store.finishTaskAction("task-2", "close-task");
    store.finishTaskAction("task-1", "advance-stage");
    expect(store.getState().pendingTaskAction).toEqual({
      taskId: "task-1",
      action: "close-task"
    });

    store.finishTaskAction("task-1", "close-task");
    expect(store.getState().pendingTaskAction).toBeNull();
    expect(store.beginTaskAction("task-1", "advance-stage")).toBe(true);
  });

  it("isolates pending actions and errors between task creation attempts", () => {
    const store = createSessionStore();
    const secondAttempt = {
      ...pendingTaskCreation,
      slotId: "create:slot-b2c3d4e5",
      taskId: "b2c3d4e5",
      prompt: "Create another task"
    };
    store.addTaskCreationAttempt({
      ...pendingTaskCreation,
      phase: "uncertain"
    });
    store.addTaskCreationAttempt({
      ...secondAttempt,
      phase: "uncertain"
    });

    expect(
      store.beginTaskCreationAction(
        pendingTaskCreation.slotId,
        "close-task"
      )
    ).toBe(true);
    expect(
      store.beginTaskCreationAction(secondAttempt.slotId, "close-task")
    ).toBe(true);
    expect(
      store.beginTaskCreationAction(
        pendingTaskCreation.slotId,
        "close-task"
      )
    ).toBe(false);

    store.setTaskCreationAttemptError(
      pendingTaskCreation.slotId,
      "First desktop is offline"
    );

    expect(store.getState().taskCreationAttempts).toEqual([
      expect.objectContaining({
        slotId: secondAttempt.slotId,
        pendingAction: "close-task",
        errorMessage: null
      }),
      expect.objectContaining({
        slotId: pendingTaskCreation.slotId,
        pendingAction: "close-task",
        errorMessage: "First desktop is offline"
      })
    ]);
    expect(store.getState().pendingTaskAction).toBeNull();

    store.finishTaskCreationAction(
      pendingTaskCreation.slotId,
      "close-task"
    );

    expect(store.getState().taskCreationAttempts).toEqual([
      expect.objectContaining({
        slotId: secondAttempt.slotId,
        pendingAction: "close-task",
        errorMessage: null
      }),
      expect.objectContaining({
        slotId: pendingTaskCreation.slotId,
        pendingAction: null,
        errorMessage: "First desktop is offline"
      })
    ]);
  });

  it("preserves repository command ownership until the run settles", () => {
    const store = createSessionStore();
    store.selectRepo("repo-1");
    store.setRepoCommandLoading("repo-1");
    store.setRepoCommandCatalog({
      repoId: "repo-1",
      revision: "catalog-v1",
      commands: [{
        id: "custom:ship",
        label: "Ship",
        description: "Release this repository",
        group: "automation"
      }]
    });

    expect(store.beginRepoCommandRun("custom:ship")).toBe(true);
    expect(store.beginRepoCommandRun("factory:create-agent")).toBe(false);
    store.selectRepo("repo-2");
    expect(store.getState()).toMatchObject({
      selectedRepoId: "repo-1",
      repoCommandStatus: "ready",
      runningRepoCommandId: "custom:ship"
    });

    store.finishRepoCommandRun("custom:ship");
    store.selectRepo("repo-2");
    expect(store.getState()).toMatchObject({
      selectedRepoId: "repo-2",
      repoCommandStatus: "idle",
      repoCommandCatalog: null,
      runningRepoCommandId: null
    });
  });

  it("retains a created command task until its collection refresh succeeds", () => {
    const store = createSessionStore();
    store.selectRepo("repo-1");
    store.setRepoCommandCatalog({
      repoId: "repo-1",
      revision: "catalog-v1",
      commands: []
    });
    store.setRepoCommandTaskLoadError({
      commandId: "factory:create-agent",
      taskId: "task-command"
    }, "The command launched successfully, but its task could not be loaded.");

    expect(store.beginRepoCommandTaskRefresh()).toEqual({
      commandId: "factory:create-agent",
      taskId: "task-command"
    });
    expect(store.getState().runningRepoCommandId).toBe("factory:create-agent");
    store.resolveRepoCommandTask("task-command");
    store.finishRepoCommandRun("factory:create-agent");
    expect(store.getState()).toMatchObject({
      repoCommandStatus: "ready",
      repoCommandErrorMessage: null,
      pendingRepoCommandTask: null,
      runningRepoCommandId: null
    });
  });

  it("commits a recovered catalog while retaining a created command task", () => {
    const store = createSessionStore();
    store.selectRepo("repo-1");
    store.setRepoCommandTaskLoadError({
      commandId: "factory:create-agent",
      taskId: "task-command"
    }, "The command launched successfully, but its task could not be loaded.");

    store.setRepoCommandLoading("repo-1");
    store.setRepoCommandCatalog({
      repoId: "repo-1",
      revision: "catalog-v2",
      commands: [{
        id: "factory:create-agent",
        label: "Create Agent",
        description: "Create a new agent definition",
        group: "configure"
      }]
    });

    expect(store.getState()).toMatchObject({
      repoCommandCatalog: { revision: "catalog-v2" },
      repoCommandStatus: "ready",
      repoCommandErrorMessage: null,
      pendingRepoCommandTask: {
        commandId: "factory:create-agent",
        taskId: "task-command"
      }
    });
  });

  it("tracks repository command failures without removing task repositories", () => {
    const store = createSessionStore();
    store.setRepos([
      { id: "repo-stale", name: "Stale" },
      { id: "repo-live", name: "Live" }
    ]);

    store.markRepoCommandsUnavailable("repo-stale");

    expect(store.getState()).toMatchObject({
      repos: [
        { id: "repo-stale", name: "Stale" },
        { id: "repo-live", name: "Live" }
      ],
      unavailableRepoCommandIds: ["repo-stale"]
    });
  });

  it("clears repository command failures for retry and successful catalogs", () => {
    const store = createSessionStore();
    store.setRepos([{ id: "repo-1", name: "Repo One" }]);
    store.markRepoCommandsUnavailable("repo-1");
    store.setRepoCommandCatalog({
      repoId: "repo-1",
      revision: "catalog-v1",
      commands: []
    });
    expect(store.getState().unavailableRepoCommandIds).toEqual([]);

    store.markRepoCommandsUnavailable("repo-1");
    store.resetRepoCommandAvailability();
    expect(store.getState().unavailableRepoCommandIds).toEqual([]);
  });

  it("creates a device id once and persists it", () => {
    const store = createSessionStore();

    expect(store.ensureMobileDeviceId(() => "mobile-generated")).toBe("mobile-generated");
    expect(store.ensureMobileDeviceId(() => "mobile-other")).toBe("mobile-generated");
    expect(store.getPersistedContext().mobileDeviceId).toBe("mobile-generated");
  });

  it("removes only the requested manual trust record", () => {
    const store = createSessionStore();
    const trustedOne = {
      desktopId: "desktop-1",
      displayName: "Desk One",
      lanEndpoints: [],
      lastSeenAt: "2026-07-17T00:00:00.000Z"
    };
    const trustedTwo = {
      desktopId: "desktop-2",
      displayName: "Desk Two",
      lanEndpoints: [],
      lastSeenAt: "2026-07-17T00:00:00.000Z"
    };
    store.setTrustedDesktops([trustedOne, trustedTwo]);

    store.removeTrustedDesktop("desktop-1");

    expect(store.getState().trustedDesktops).toEqual([trustedTwo]);
  });

  it("stores machine source warnings as runtime-only diagnostics", () => {
    const store = createSessionStore();

    store.setMachineSourceWarnings({
      account: "Cloud unavailable",
      local: null
    });

    expect(store.getState().machineSourceWarnings).toEqual({
      account: "Cloud unavailable",
      local: null
    });
    expect(store.getPersistedContext()).not.toHaveProperty("machineSourceWarnings");
  });

  it("drops account machine sources but keeps manually paired machines", () => {
    const store = createSessionStore();
    store.setTrustedDesktops([
      {
        desktopId: "desktop-paired",
        displayName: "Paired Mac",
        lanEndpoints: [],
        lastSeenAt: "2026-08-19T00:00:00.000Z"
      }
    ]);
    store.setMachineSourceDesktops({
      account: [
        { id: "desktop-account", name: "Account Mac", online: true, mode: "remote" }
      ],
      local: [
        { id: "desktop-paired", name: "Paired Mac", online: true, mode: "lan" },
        { id: "desktop-account", name: "Account Mac", online: true, mode: "lan" }
      ]
    });
    store.setMachineSourceWarnings({
      account: "Cloud unavailable",
      local: "LAN unavailable"
    });

    store.resetAccountScopedMachines();

    expect(store.getState()).toMatchObject({
      accountDesktops: [],
      // Only account trust made the account-only machine readable over the
      // LAN; the paired machine's own credential outlives the account.
      liveLanDesktops: [
        { id: "desktop-paired", name: "Paired Mac", online: true, mode: "lan" }
      ],
      machineSourceWarnings: { account: null, local: "LAN unavailable" },
      trustedDesktops: [expect.objectContaining({ desktopId: "desktop-paired" })]
    });
  });

  it("publishes nothing when there is no account machine state to drop", () => {
    const store = createSessionStore();
    store.setTrustedDesktops([
      {
        desktopId: "desktop-paired",
        displayName: "Paired Mac",
        lanEndpoints: [],
        lastSeenAt: "2026-08-19T00:00:00.000Z"
      }
    ]);
    store.setMachineSourceDesktops({
      account: [],
      local: [
        { id: "desktop-paired", name: "Paired Mac", online: true, mode: "lan" }
      ]
    });
    const publications: number[] = [];
    store.subscribe(() => publications.push(publications.length));

    store.resetAccountScopedMachines();

    expect(publications).toEqual([]);
  });

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

  it("keeps this phone's own pin/dismiss record as published state", () => {
    const store = createSessionStore();
    expect(store.getState().localTaskListPreferences).toEqual({
      pins: [],
      dismissedActivity: [],
      pinsSeededFromServer: false
    });

    const preferences = {
      pins: [{ taskId: "task-1", repoId: "repo-1" }],
      dismissedActivity: [
        { taskId: "task-2", repoId: "repo-1", activityRevision: 3 }
      ],
      pinsSeededFromServer: true
    };
    let published = 0;
    const unsubscribe = store.subscribe(() => {
      published += 1;
    });
    store.setLocalTaskListPreferences(preferences);
    unsubscribe();

    expect(store.getState().localTaskListPreferences).toBe(preferences);
    expect(published).toBe(1);
  });

  it("leaves the desktop's own pin columns on task payloads untouched", () => {
    const store = createSessionStore();
    const desktopPinned = {
      id: "task-1",
      repoId: "repo-1",
      title: "Refactor mobile shell",
      stage: "in progress",
      pinned: true,
      pinOrder: 0
    };

    store.setRecentTasks([desktopPinned]);
    store.setLocalTaskListPreferences({
      pins: [],
      dismissedActivity: [],
      pinsSeededFromServer: true
    });

    // Mobile pin state lives beside the task, never on it: a phone with no
    // pins does not rewrite what the desktop reported.
    expect(store.getState().recentTasks[0]).toMatchObject({
      pinned: true,
      pinOrder: 0
    });
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

  it("hydrates a pending attempt as uncertain without taking over the composer", () => {
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
      composerRepoId: null,
      composerPrompt: "",
      composerDesktopId: null,
      // Hydration leaves the provider unresolved: it is only knowable once a
      // machine is selected and its inventory is known.
      composerAgentProvider: null,
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

    expect(persisted.taskCreationAttempts).toEqual([pendingTaskCreation]);
    expect(persisted).not.toHaveProperty("pendingTaskCreation");
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
      taskTerminalStatus: "live"
    });
    expect(terminalText(store)).toBe("Existing output");
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
      taskTerminalCols: 132,
      taskTerminalRows: 43
    });
    expect(terminalText(store)).toBe("snapshot\ndelta\n");
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

  it("tracks visual companion availability, unread revisions, retagging, and cleanup", () => {
    const store = createSessionStore();
    store.beginTaskCompanion("task-pending");
    expect(store.getState()).toMatchObject({
      taskCompanionTaskId: "task-pending",
      taskCompanionStatus: "connecting",
      taskCompanionSnapshot: null,
      taskCompanionUnread: false
    });

    store.applyTaskCompanionStreamEvent("task-pending", {
      type: "snapshot",
      taskId: "task-pending",
      sessionId: "123-456",
      revision: "rev-1",
      documentKind: "fragment",
      html: "<h2>First</h2>",
      sourceOrigin: "http://localhost:4312",
      assets: [
        {
          name: "layout.png",
          contentType: "image/png",
          digest: "digest-1",
          dataB64: "UE5H"
        }
      ]
    }, false);
    expect(store.getState()).toMatchObject({
      taskCompanionStatus: "available",
      taskCompanionUnread: true,
      taskCompanionSnapshot: {
        revision: "rev-1",
        sourceOrigin: "http://localhost:4312",
        assets: []
      }
    });
    store.markTaskCompanionViewed("task-pending");
    expect(store.getState().taskCompanionUnread).toBe(false);

    store.applyTaskCompanionStreamEvent("task-pending", {
      type: "snapshot",
      taskId: "task-pending",
      sessionId: "123-456",
      revision: "rev-2",
      documentKind: "full_document",
      html: "<html><body>Second</body></html>"
    }, true);
    expect(store.getState()).toMatchObject({
      taskCompanionUnread: false,
      taskCompanionSnapshot: { revision: "rev-2" }
    });
    store.beginTaskCompanionEvent("task-pending", "mobile-1");
    expect(store.getState().taskCompanionEventStatus).toBe("sending");
    store.applyTaskCompanionStreamEvent("task-pending", {
      type: "event_result",
      taskId: "task-pending",
      sessionId: "123-456",
      revision: "rev-2",
      eventId: "mobile-1",
      accepted: false,
      code: "stale_revision",
      message: "The companion changed before the selection arrived."
    }, true);
    expect(store.getState()).toMatchObject({
      taskCompanionStatus: "available",
      taskCompanionSnapshot: { revision: "rev-2" },
      taskCompanionErrorMessage:
        "The companion changed before the selection arrived.",
      taskCompanionEventStatus: "error"
    });
    store.beginTaskCompanionEvent("task-pending", "mobile-2");
    store.applyTaskCompanionStreamEvent("task-pending", {
      type: "event_result",
      taskId: "task-pending",
      sessionId: "123-456",
      revision: "rev-2",
      eventId: "mobile-1",
      accepted: true
    }, true);
    expect(store.getState().taskCompanionEventStatus).toBe("sending");
    store.applyTaskCompanionStreamEvent("task-pending", {
      type: "event_result",
      taskId: "task-pending",
      sessionId: "123-456",
      revision: "rev-2",
      eventId: "mobile-2",
      accepted: true
    }, true);
    expect(store.getState()).toMatchObject({
      taskCompanionErrorMessage: null,
      taskCompanionEventStatus: "sent"
    });

    store.retagTaskIdentity("task-pending", "task-published");
    expect(store.getState().taskCompanionTaskId).toBe("task-published");
    store.applyTaskCompanionStreamEvent("task-pending", {
      type: "unavailable",
      taskId: "task-pending"
    }, false);
    expect(store.getState().taskCompanionStatus).toBe("available");
    store.applyTaskCompanionStreamEvent("task-published", {
      type: "unavailable",
      taskId: "task-published"
    }, false);
    expect(store.getState()).toMatchObject({
      taskCompanionStatus: "unavailable",
      taskCompanionSnapshot: null,
      taskCompanionUnread: false
    });
    store.applyTaskCompanionStreamEvent("task-published", {
      type: "error",
      taskId: "task-published",
      code: "companion_source_failed",
      message: "Unreadable"
    }, false);
    expect(store.getState()).toMatchObject({
      taskCompanionStatus: "error",
      taskCompanionErrorMessage: "Unreadable"
    });
    store.clearTaskCompanion();
    expect(store.getState()).toMatchObject({
      taskCompanionTaskId: null,
      taskCompanionStatus: "idle",
      taskCompanionSnapshot: null,
      taskCompanionUnread: false,
      taskCompanionErrorMessage: null
    });
  });

  it("invalidates companion content across reconnect until a fresh snapshot arrives", () => {
    const store = createSessionStore();
    store.beginTaskCompanion("task-1");
    store.applyTaskCompanionStreamEvent(
      "task-1",
      {
        type: "snapshot",
        taskId: "task-1",
        sessionId: "session-1",
        revision: "rev-1",
        documentKind: "fragment",
        html: '<button data-choice="a">A</button>'
      },
      true
    );
    store.beginTaskCompanionEvent("task-1", "event-1");

    store.applyTaskCompanionStreamEvent(
      "task-1",
      { type: "connection", taskId: "task-1", connected: false },
      true
    );
    expect(store.getState()).toMatchObject({
      taskCompanionStatus: "reconnecting",
      taskCompanionSnapshot: null,
      taskCompanionEventId: null,
      taskCompanionEventStatus: "error",
      taskCompanionErrorMessage:
        "Connection lost before the selection was confirmed. Retry after reconnecting."
    });

    store.applyTaskCompanionStreamEvent(
      "task-1",
      { type: "connection", taskId: "task-1", connected: true },
      true
    );
    expect(store.getState()).toMatchObject({
      taskCompanionStatus: "reconnecting",
      taskCompanionSnapshot: null
    });

    store.applyTaskCompanionStreamEvent(
      "task-1",
      {
        type: "snapshot",
        taskId: "task-1",
        sessionId: "session-1",
        revision: "rev-2",
        documentKind: "fragment",
        html: '<button data-choice="a">A again</button>'
      },
      true
    );
    expect(store.getState()).toMatchObject({
      taskCompanionStatus: "available",
      taskCompanionSnapshot: { revision: "rev-2" },
      taskCompanionEventStatus: "idle",
      taskCompanionErrorMessage: null
    });
  });

  it("invalidates stale companion content and pending events on a source error", () => {
    const store = createSessionStore();
    store.beginTaskCompanion("task-1");
    store.applyTaskCompanionStreamEvent("task-1", {
      type: "snapshot",
      taskId: "task-1",
      sessionId: "session-1",
      revision: "rev-1",
      documentKind: "fragment",
      html: '<button data-choice="a">A</button>'
    }, false);
    store.beginTaskCompanionEvent("task-1", "event-1");

    store.applyTaskCompanionStreamEvent("task-1", {
      type: "error",
      taskId: "task-1",
      code: "companion_too_large",
      message:
        "The visual companion is too large. Ask the agent to simplify the screen."
    }, false);

    expect(store.getState()).toMatchObject({
      taskCompanionStatus: "error",
      taskCompanionSnapshot: null,
      taskCompanionUnread: false,
      taskCompanionErrorMessage:
        "The visual companion is too large. Ask the agent to simplify the screen.",
      taskCompanionEventId: null,
      taskCompanionEventStatus: "idle"
    });
  });

  it("keeps the current document visible for a rejected companion event retry", () => {
    const store = createSessionStore();
    store.beginTaskCompanion("task-1");
    store.applyTaskCompanionStreamEvent("task-1", {
      type: "snapshot",
      taskId: "task-1",
      sessionId: "session-1",
      revision: "rev-1",
      documentKind: "fragment",
      html: '<button data-choice="a">A</button>'
    }, true);
    store.beginTaskCompanionEvent("task-1", "event-1");

    store.applyTaskCompanionStreamEvent("task-1", {
      type: "event_result",
      taskId: "task-1",
      sessionId: "session-1",
      revision: "rev-1",
      eventId: "event-1",
      accepted: false,
      code: "companion_event_failed",
      message: "The selection could not be recorded."
    }, true);

    expect(store.getState()).toMatchObject({
      taskCompanionStatus: "available",
      taskCompanionSnapshot: { revision: "rev-1" },
      taskCompanionErrorMessage: "The selection could not be recorded.",
      taskCompanionEventId: "event-1",
      taskCompanionEventStatus: "error"
    });
  });

  it("only applies companion event results for the exact current snapshot", () => {
    const store = createSessionStore();
    store.beginTaskCompanion("task-1");
    store.applyTaskCompanionStreamEvent("task-1", {
      type: "snapshot",
      taskId: "task-1",
      sessionId: "session-current",
      revision: "revision-current",
      documentKind: "fragment",
      html: '<button data-choice="a">A</button>'
    }, true);
    store.beginTaskCompanionEvent("task-1", "event-reused");

    store.applyTaskCompanionStreamEvent("task-1", {
      type: "event_result",
      taskId: "task-1",
      sessionId: "session-stale",
      revision: "revision-current",
      eventId: "event-reused",
      accepted: true
    }, true);
    expect(store.getState().taskCompanionEventStatus).toBe("sending");

    store.applyTaskCompanionStreamEvent("task-1", {
      type: "event_result",
      taskId: "task-1",
      sessionId: "session-current",
      revision: "revision-stale",
      eventId: "event-reused",
      accepted: true
    }, true);
    expect(store.getState().taskCompanionEventStatus).toBe("sending");

    store.applyTaskCompanionStreamEvent("task-1", {
      type: "event_result",
      taskId: "task-1",
      sessionId: "session-current",
      revision: "revision-current",
      eventId: "event-reused",
      accepted: true
    }, true);
    expect(store.getState().taskCompanionEventStatus).toBe("sent");
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
      taskTerminalStatus: "idle"
    });
    expect(terminalText(store)).toBe("");
  });

  it("preserves terminal stream error messages on the active terminal only", () => {
    const store = createSessionStore();

    store.beginTaskTerminal("task-1", "Existing output");
    store.setTaskTerminalError("task-1", "No terminal session is available for this task");
    store.setTaskTerminalError("task-2", "Desktop offline");

    expect(store.getState()).toMatchObject({
      taskTerminalTaskId: "task-1",
      taskTerminalStatus: "error",
      taskTerminalErrorMessage: "No terminal session is available for this task"
    });
    expect(terminalText(store)).toBe("Existing output");

    store.clearTaskTerminal();

    expect(store.getState()).toMatchObject({
      taskTerminalTaskId: null,
      taskTerminalStatus: "idle",
      taskTerminalErrorMessage: null
    });
    expect(terminalText(store)).toBe("");
  });

  it("keeps a snapshot larger than the live-output cap", () => {
    const store = createSessionStore();
    store.beginTaskTerminal("task-1", "");

    const snapshot = "A".repeat(1_100_000);
    store.appendTaskTerminal("task-1", `${snapshot}\n`);

    expect(terminalText(store)).toBe(`${snapshot}\n`);
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
      taskTerminalOutputEpoch: previousEpoch + 1,
      taskTerminalOutputStart: 0,
      taskTerminalCols: 132,
      taskTerminalRows: 43,
      taskTerminalErrorMessage: null
    });
    expect(terminalText(store)).toBe("fresh-snapshot\n");
    expect(publishes).toBe(1);
  });

  it("records the retained scrollback a bounded snapshot names", () => {
    const store = createSessionStore();
    store.beginTaskTerminal("task-1", "");

    store.replaceTaskTerminalSnapshot("task-1", "d2luZG93", 132, 43, {
      streamId: 3,
      historyId: 9,
      scrollbackLines: 1_200
    });

    expect(store.getState().taskTerminalScrollback).toEqual({
      historyId: 9,
      remainingLines: 1_200,
      loading: false,
      atClientLimit: false
    });

    // A desktop that sent the whole terminal has nothing retained.
    store.replaceTaskTerminalSnapshot("task-1", "d2hvbGU=", 132, 43);
    expect(store.getState().taskTerminalScrollback).toBeNull();
  });

  it("splices older scrollback above the loaded buffer", () => {
    const store = createSessionStore();
    store.beginTaskTerminal("task-1", "");
    store.replaceTaskTerminalSnapshot("task-1", "d2luZG93", 132, 43, {
      streamId: 3,
      historyId: 9,
      scrollbackLines: 400
    });
    store.appendTaskTerminal("task-1", "bGl2ZQ==\n");
    const epochBefore = store.getState().taskTerminalOutputEpoch;
    let prepended: boolean | null = null;
    store.taskTerminalOutputSource.subscribe(() => {
      prepended = store.taskTerminalOutputSource.getSnapshot().prependedScrollback;
    });

    store.setTaskTerminalScrollbackLoading("task-1", true);
    store.prependTaskTerminalScrollback("task-1", {
      requestId: 1,
      historyId: 9,
      startLine: 200,
      endLine: 400,
      dataB64: "b2xkZXI=",
      remainingLines: 200
    });

    expect(terminalText(store)).toBe("b2xkZXI=\nd2luZG93\nbGl2ZQ==\n");
    expect(store.getState().taskTerminalOutputEpoch).toBe(epochBefore + 1);
    expect(store.getState().taskTerminalScrollback).toEqual({
      historyId: 9,
      remainingLines: 200,
      loading: false,
      atClientLimit: false
    });
    expect(prepended).toBe(true);
  });

  it("refuses a prepend that would not fit rather than evicting the middle", () => {
    // The reviewer's reproduction: a 340k-char window plus a 200k-char live
    // frame, then 87k-char chunks walked upward past the client's bound. Under
    // front-eviction the 6th prepend silently dropped the 5th; the buffer must
    // instead stop growing and stay contiguous.
    const store = createSessionStore();
    store.beginTaskTerminal("task-1", "");
    const windowFrame = "W".repeat(340_000);
    store.replaceTaskTerminalSnapshot("task-1", windowFrame, 132, 43, {
      streamId: 3,
      historyId: 9,
      scrollbackLines: 5_000
    });
    store.appendTaskTerminal("task-1", `${"L".repeat(200_000)}\n`);

    const chunks: string[] = [];
    let accepted = 0;
    for (let index = 0; index < 20; index += 1) {
      const dataB64 = `${`${index}`.padStart(8, "C")}${"c".repeat(87_000)}`;
      const before = store.getState().taskTerminalScrollback;
      store.prependTaskTerminalScrollback("task-1", {
        requestId: index,
        historyId: 9,
        startLine: 5_000 - (index + 1) * 200,
        endLine: 5_000 - index * 200,
        dataB64,
        remainingLines: 5_000 - (index + 1) * 200
      });
      const after = store.getState().taskTerminalScrollback;
      if (after?.atClientLimit && !before?.atClientLimit) {
        // Refused: the buffer keeps exactly what it had.
        break;
      }
      chunks.unshift(dataB64);
      accepted += 1;
    }

    expect(accepted).toBeGreaterThan(5);
    expect(store.getState().taskTerminalScrollback).toMatchObject({
      historyId: 9,
      loading: false,
      atClientLimit: true
    });
    // Contiguous: every accepted chunk, in order, then the window, then live —
    // nothing missing between the newest prepended chunk and the retained tail.
    const frames = terminalText(store).split("\n").filter(Boolean);
    expect(frames).toEqual([
      ...chunks,
      windowFrame,
      "L".repeat(200_000)
    ]);
  });

  it("keeps the prepended history contiguous while live output evicts", () => {
    const store = createSessionStore();
    store.beginTaskTerminal("task-1", "");
    store.replaceTaskTerminalSnapshot("task-1", "d2luZG93", 132, 43, {
      streamId: 3,
      historyId: 9,
      scrollbackLines: 400
    });
    store.prependTaskTerminalScrollback("task-1", {
      requestId: 1,
      historyId: 9,
      startLine: 200,
      endLine: 400,
      dataB64: "b2xkZXI=",
      remainingLines: 200
    });

    // Push the live region past its own cap. Eviction stays where it always
    // was — the front of live output — and never reaches back into the
    // prepended history or the window frame between them.
    const liveFrames = Array.from({ length: 12 }, (_, index) =>
      String.fromCharCode(97 + index).repeat(100_000)
    );
    for (const frame of liveFrames) {
      store.appendTaskTerminal("task-1", `${frame}\n`);
    }

    const frames = terminalText(store).split("\n").filter(Boolean);
    expect(frames[0]).toBe("b2xkZXI=");
    expect(frames[1]).toBe("d2luZG93");
    // The surviving live frames are a contiguous suffix of what was appended:
    // eviction took whole frames off the front and nothing from the middle.
    const live = frames.slice(2);
    expect(live.length).toBeLessThan(liveFrames.length);
    expect(live).toEqual(liveFrames.slice(liveFrames.length - live.length));
  });

  it("ignores a scrollback chunk cut from a replaced history", () => {
    const store = createSessionStore();
    store.beginTaskTerminal("task-1", "");
    store.replaceTaskTerminalSnapshot("task-1", "d2luZG93", 132, 43, {
      streamId: 3,
      historyId: 9,
      scrollbackLines: 400
    });

    store.prependTaskTerminalScrollback("task-1", {
      requestId: 1,
      historyId: 10,
      startLine: 0,
      endLine: 200,
      dataB64: "c3RhbGU=",
      remainingLines: 0
    });

    expect(terminalText(store)).toBe("d2luZG93\n");
    expect(store.getState().taskTerminalScrollback).toEqual({
      historyId: 9,
      remainingLines: 400,
      loading: false,
      atClientLimit: false
    });
  });

  it("keeps the rendered buffer when the desktop resumes the stream", () => {
    const store = createSessionStore();
    store.beginTaskTerminal("task-1", "");
    store.replaceTaskTerminalSnapshot("task-1", "d2luZG93", 132, 43, {
      streamId: 3,
      historyId: 9,
      scrollbackLines: 400
    });
    store.appendTaskTerminal("task-1", "bGl2ZQ==\n");
    const epochBefore = store.getState().taskTerminalOutputEpoch;

    store.resumeTaskTerminal("task-1", {
      streamId: 3,
      historyId: 9,
      scrollbackLines: 400
    });

    expect(terminalText(store)).toBe("d2luZG93\nbGl2ZQ==\n");
    expect(store.getState().taskTerminalOutputEpoch).toBe(epochBefore);
    expect(store.getState().taskTerminalStatus).toBe("live");
  });

  it("keeps the scrollback walk cursor across a resume of the same history", () => {
    // `scrollbackLines` on a resume is the desktop's full retained history, not
    // what this viewer has left to pull. Adopting it would rewind the walk and
    // re-pull rows the buffer already holds.
    const store = createSessionStore();
    store.beginTaskTerminal("task-1", "");
    store.replaceTaskTerminalSnapshot("task-1", "d2luZG93", 132, 43, {
      streamId: 3,
      historyId: 9,
      scrollbackLines: 400
    });
    store.prependTaskTerminalScrollback("task-1", {
      requestId: 1,
      historyId: 9,
      startLine: 200,
      endLine: 400,
      dataB64: "b2xkZXI=",
      remainingLines: 200
    });
    expect(store.getState().taskTerminalScrollback?.remainingLines).toBe(200);

    store.resumeTaskTerminal("task-1", {
      streamId: 3,
      historyId: 9,
      scrollbackLines: 400
    });

    expect(store.getState().taskTerminalScrollback).toEqual({
      historyId: 9,
      remainingLines: 200,
      loading: false,
      atClientLimit: false
    });
    expect(terminalText(store)).toBe("b2xkZXI=\nd2luZG93\n");
  });

  it("keeps the client limit across a resume of the same history", () => {
    const store = createSessionStore();
    store.beginTaskTerminal("task-1", "");
    store.replaceTaskTerminalSnapshot("task-1", "d2luZG93", 132, 43, {
      streamId: 3,
      historyId: 9,
      scrollbackLines: 400
    });
    store.markTaskTerminalScrollbackAtClientLimit("task-1");
    expect(store.getState().taskTerminalScrollback?.atClientLimit).toBe(true);

    store.resumeTaskTerminal("task-1", {
      streamId: 3,
      historyId: 9,
      scrollbackLines: 400
    });

    // A viewer that had stopped at the client bound must not restart the walk
    // and prepend duplicates until the refusal fires again.
    expect(store.getState().taskTerminalScrollback?.atClientLimit).toBe(true);
  });

  it("stops the walk when a resume reports a history the viewer did not pull from", () => {
    const store = createSessionStore();
    store.beginTaskTerminal("task-1", "");
    store.replaceTaskTerminalSnapshot("task-1", "d2luZG93", 132, 43, {
      streamId: 3,
      historyId: 9,
      scrollbackLines: 400
    });
    store.prependTaskTerminalScrollback("task-1", {
      requestId: 1,
      historyId: 9,
      startLine: 200,
      endLine: 400,
      dataB64: "b2xkZXI=",
      remainingLines: 200
    });

    // The desktop took a fresh base while this viewer was away: its line
    // indices do not address the rows already loaded here.
    store.resumeTaskTerminal("task-1", {
      streamId: 3,
      historyId: 10,
      scrollbackLines: 900
    });

    expect(store.getState().taskTerminalScrollback).toBeNull();
    // The rendered buffer is untouched — the replayed delta keeps it correct.
    expect(terminalText(store)).toBe("b2xkZXI=\nd2luZG93\n");
  });

  it("evicts only whole oldest live frames while retaining the snapshot", () => {
    const store = createSessionStore();
    store.beginTaskTerminal("task-1", "");

    const snapshot = "A".repeat(300_000);
    const liveFrames = ["B", "C", "D", "E"].map((value) =>
      value.repeat(300_000)
    );
    store.appendTaskTerminal("task-1", `${snapshot}\n`);
    for (const frame of liveFrames) {
      store.appendTaskTerminal("task-1", `${frame}\n`);
    }

    const state = store.getState();
    const frames = terminalOutputToString(state.taskTerminalOutput)
      .split("\n")
      .filter(Boolean);
    expect(frames).toEqual([snapshot, ...liveFrames.slice(-3)]);
    expect(state.taskTerminalOutputStart).toBe(300_001);
  });

  it("keeps one oversized live frame whole after the snapshot", () => {
    const store = createSessionStore();
    store.beginTaskTerminal("task-1", "");

    const snapshot = "c25hcHNob3Q=";
    const liveFrame = "B".repeat(1_100_000);
    store.appendTaskTerminal("task-1", `${snapshot}\n`);
    store.appendTaskTerminal("task-1", `${liveFrame}\n`);

    expect(terminalText(store)).toBe(`${snapshot}\n${liveFrame}\n`);
  });

  it("keeps a large snapshot plus live frames decodable through the accumulation cap", () => {
    const store = createSessionStore();
    store.beginTaskTerminal("task-1", "");
    store.setTaskTerminalDims("task-1", 220, 72);

    const snapshotText = "snapshot scrollback row\r\n".repeat(40_000);
    const snapshotFrame = Buffer.from(snapshotText, "utf8").toString("base64");
    const liveFrame = Buffer.from("LIVE-APPEND-CORRECT", "utf8").toString("base64");
    expect(snapshotFrame.length).toBeGreaterThan(1_000_000);

    store.appendTaskTerminal("task-1", `${snapshotFrame}\n`);
    store.appendTaskTerminal("task-1", `${liveFrame}\n`);

    const state = store.getState();
    const frames = terminalOutputToString(state.taskTerminalOutput)
      .split("\n")
      .filter(Boolean);
    const decoded = frames.map((frame) => Buffer.from(frame, "base64").toString("utf8")).join("");

    expect(state.taskTerminalCols).toBe(220);
    expect(state.taskTerminalRows).toBe(72);
    expect(frames).toEqual([snapshotFrame, liveFrame]);
    expect(decoded).toContain("snapshot scrollback row");
    expect(decoded).toContain("LIVE-APPEND-CORRECT");
  });

  it("does not rescan the snapshot boundary for every live frame", () => {
    const store = createSessionStore();
    const snapshotFrame = "A".repeat(750_000);
    const liveFrame = "bGl2ZQ==\n";
    store.beginTaskTerminal("task-1", "");
    store.replaceTaskTerminalSnapshot("task-1", snapshotFrame, 132, 43);

    const indexOfSpy = vi.spyOn(String.prototype, "indexOf");
    store.appendTaskTerminal("task-1", liveFrame);

    const scannedInputs = indexOfSpy.mock.contexts.map((value) => String(value));
    indexOfSpy.mockRestore();
    expect(scannedInputs).not.toContain(`${snapshotFrame}\n${liveFrame}`);
    expect(terminalText(store)).toBe(`${snapshotFrame}\n${liveFrame}`);
  });

  it("routes live terminal frames outside the application-state render boundary", () => {
    const store = createSessionStore();
    store.beginTaskTerminal("task-1", "");
    store.replaceTaskTerminalSnapshot("task-1", "c25hcHNob3Q=", 132, 43);
    let applicationPublications = 0;
    let terminalPublications = 0;
    store.subscribe(() => {
      applicationPublications += 1;
    });
    store.taskTerminalOutputSource.subscribe(() => {
      terminalPublications += 1;
    });

    const frameCount = 10_000;
    for (let index = 0; index < frameCount; index += 1) {
      store.appendTaskTerminal(
        "task-1",
        `${Buffer.from(`frame-${index}`).toString("base64")}\n`
      );
    }

    expect(applicationPublications).toBe(0);
    expect(terminalPublications).toBe(frameCount);
    expect(store.taskTerminalOutputSource.getSnapshot()).toMatchObject({
      taskId: "task-1",
      outputEpoch: store.getState().taskTerminalOutputEpoch,
      outputStart: store.getState().taskTerminalOutputStart,
      status: "live"
    });
    expect(terminalText(store)).toContain(
      Buffer.from(`frame-${frameCount - 1}`).toString("base64")
    );
  });

  it("publishes the one application-state transition when output recovers an error", () => {
    const store = createSessionStore();
    store.beginTaskTerminal("task-1", "");
    store.setTaskTerminalError("task-1", "Connection interrupted");
    let applicationPublications = 0;
    store.subscribe(() => {
      applicationPublications += 1;
    });

    store.appendTaskTerminal("task-1", "cmVjb3ZlcmVk\n");
    store.appendTaskTerminal("task-1", "c3RlYWR5\n");

    expect(applicationPublications).toBe(1);
    expect(store.getState()).toMatchObject({
      taskTerminalStatus: "live",
      taskTerminalErrorMessage: null
    });
    expect(terminalText(store)).toContain("c3RlYWR5");
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

  it("keeps a dismissed activity through a stale refresh and accepts a later revision", () => {
    const store = createSessionStore();
    const task = {
      id: "task-activity",
      repoId: "repo-1",
      title: "Activity",
      stage: "review",
      activity: "unread" as const,
      activityRevision: 4
    };
    store.setRecentTasks([task]);
    store.setTaskActivity("task-activity", "idle", 5);

    store.setRecentTasks([task]);
    expect(store.getState().recentTasks[0]).toMatchObject({
      activity: "idle",
      activityRevision: 5
    });

    store.setRecentTasks([
      { ...task, activity: "unread", activityRevision: 6 }
    ]);
    expect(store.getState().recentTasks[0]).toMatchObject({
      activity: "unread",
      activityRevision: 6
    });
  });

  it("does not lower newer activity revisions while acknowledging stale task copies", () => {
    const store = createSessionStore();
    const task = {
      id: "task-activity",
      repoId: "repo-1",
      title: "Activity",
      stage: "review",
      activity: "unread" as const
    };
    store.setRepoTasks([{ ...task, activityRevision: 6 }]);
    store.setRecentTasks([{ ...task, activityRevision: 9 }]);
    store.setSearchResults("Activity", [{ ...task, activityRevision: 7 }]);

    store.setTaskActivity("task-activity", "idle", 8);

    expect(store.getState().repoTasks[0]).toMatchObject({
      activity: "idle",
      activityRevision: 8
    });
    expect(store.getState().searchResults[0]).toMatchObject({
      activity: "idle",
      activityRevision: 8
    });
    expect(store.getState().recentTasks[0]).toMatchObject({
      activity: "unread",
      activityRevision: 9
    });
  });

  it("publishes when only relationship fields change on a refreshed task", () => {
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
        stage: "in progress",
        blockedByTaskIds: ["task-blocker"]
      }
    ]);
    publishes = 0;

    // Unblocking changes no other summary field; the list must still update.
    store.setRecentTasks([
      {
        id: "task-2",
        repoId: "repo-2",
        title: "Recent task",
        stage: "in progress",
        blockedByTaskIds: []
      }
    ]);
    expect(publishes).toBe(1);
    expect(store.getState().recentTasks[0]?.blockedByTaskIds).toEqual([]);

    store.setRecentTasks([
      {
        id: "task-2",
        repoId: "repo-2",
        title: "Recent task",
        stage: "in progress",
        blockedByTaskIds: [],
        parentTaskId: "task-parent"
      }
    ]);
    expect(publishes).toBe(2);
    expect(store.getState().recentTasks[0]?.parentTaskId).toBe("task-parent");
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
