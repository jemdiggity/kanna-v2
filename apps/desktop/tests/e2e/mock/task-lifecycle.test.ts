import { setTimeout as sleep } from "node:timers/promises";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase, importTestRepo, cleanupWorktrees } from "../helpers/reset";
import { callVueMethod, execDb, getVueState, queryDb, tauriInvoke } from "../helpers/vue";
import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { resolveAppKannaServer } from "../helpers/kannaServer";
import { buildGlobalKeydownScript } from "../helpers/keyboard";
import { localProcessFetch } from "@kanna/local-process-fetch";

async function waitForPipelineItem<T>(
  client: WebDriverClient,
  sql: string,
  params: unknown[],
  predicate: (row: T | undefined) => boolean,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastRow: T | undefined;

  while (Date.now() < deadline) {
    const rows = (await queryDb(client, sql, params)) as T[];
    lastRow = rows[0];
    if (predicate(lastRow)) return lastRow;
    await sleep(100);
  }

  throw new Error(`Timed out waiting for task state; last row was ${JSON.stringify(lastRow)}`);
}

async function waitForCondition(
  predicate: () => Promise<boolean>,
  description: string,
  timeoutMs = 5_000,
  diagnostics?: () => Promise<unknown>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch {
      // The webview can be between documents during a reload.
    }
    await sleep(100);
  }

  let lastDiagnostics: unknown = null;
  try {
    lastDiagnostics = await diagnostics?.();
  } catch (error) {
    lastDiagnostics = { diagnosticError: error instanceof Error ? error.message : String(error) };
  }

  const diagnosticSuffix = diagnostics
    ? `; last observed state: ${JSON.stringify(lastDiagnostics)}`
    : "";
  throw new Error(`Timed out waiting for ${description}${diagnosticSuffix}`);
}

async function seedPtyTask(
  client: WebDriverClient,
  task: {
    id: string;
    repoId: string;
    prompt: string;
    stage: string;
    branch: string;
    closedAt: string | null;
    createdAt: string;
  },
): Promise<void> {
  await execDb(
    client,
    `INSERT INTO pipeline_item (
       id, repo_id, prompt, pipeline, stage, branch,
       agent_type, agent_provider, activity, closed_at, created_at, updated_at
     ) VALUES (?, ?, ?, 'default', ?, ?, 'pty', 'claude', 'idle', ?, ?, ?)`,
    [
      task.id,
      task.repoId,
      task.prompt,
      task.stage,
      task.branch,
      task.closedAt,
      task.createdAt,
      task.createdAt,
    ],
  );
}

async function persistWindowSelection(
  client: WebDriverClient,
  selection: {
    repoId: string;
    itemId: string;
  },
): Promise<void> {
  const result = await client.executeAsync<string>(
    `const cb = arguments[arguments.length - 1];
     const ctx = window.__KANNA_E2E__.setupState;
     Promise.resolve(ctx.windowWorkspace.persistSelection({
       selectedRepoId: ${JSON.stringify(selection.repoId)},
       selectedItemId: ${JSON.stringify(selection.itemId)},
     }))
       .then(() => cb("ok"))
       .catch((error) => cb("__error:" + (error?.message || String(error))));`,
  );
  expect(result).toBe("ok");
}

async function getAppInvokeMetrics(client: WebDriverClient): Promise<{
  invokeCounts: Record<string, number>;
  invokeCalls?: Array<{ command: string; args: unknown }>;
}> {
  return client.executeSync(
    `return window.__KANNA_E2E__.appMetrics.snapshot();`,
  );
}

interface TaskCreationE2eState {
  createResponseHeld: boolean;
  createResponseReleased: boolean;
  responseTaskId: string | null;
  snapshotResponsesHeld: number;
  snapshotResponsesHeldAfterCreateRelease: number;
  creationStatus: "pending" | "fulfilled" | "rejected";
  creationError: string | null;
  createdTaskId: string | null;
  slotId: string | null;
  rowCount: number;
  repoCount: string;
  rowText: string;
  dataTaskId: string | null;
  ariaBusy: string | null;
  selected: boolean;
  sameNode: boolean;
  selectedItemId: string | null;
  selectedTaskId: string | null;
  currentSlotState: string | null;
  currentSlotTaskId: string | null;
  currentSlotHasTask: boolean;
  durableItemPresent: boolean;
  observerSamples: number;
  observerViolations: string[];
}

async function getTaskCreationE2eState(
  client: WebDriverClient,
  repoId: string,
): Promise<TaskCreationE2eState> {
  return client.executeSync<TaskCreationE2eState>(
    `const gate = window.__KANNA_TASK_CREATION_GATE__;
     const ctx = window.__KANNA_E2E__.setupState;
     const unwrap = (value) => value && value.__v_isRef ? value.value : value;
     const store = ctx.store;
     const repo = document.querySelector(${JSON.stringify(`.repo-section[data-repo-id="${repoId}"]`)});
     const rows = repo ? Array.from(repo.querySelectorAll(".workflow-item")) : [];
     const row = gate?.slotId
       ? rows.find((candidate) => candidate.dataset.slotId === gate.slotId) ?? null
       : rows[0] ?? null;
     const items = Array.from(unwrap(store?.items) ?? []);
     const currentSlot = unwrap(store?.currentTaskSlot) ?? null;
     gate?.record?.();
     return {
       createResponseHeld: gate?.createResponseHeld === true,
       createResponseReleased: gate?.createResponseReleased === true,
       responseTaskId: gate?.responseTaskId ?? null,
       snapshotResponsesHeld: gate?.snapshotResponsesHeld ?? 0,
       snapshotResponsesHeldAfterCreateRelease: gate?.snapshotResponsesHeldAfterCreateRelease ?? 0,
       creationStatus: gate?.creationStatus ?? "pending",
       creationError: gate?.creationError ?? null,
       createdTaskId: gate?.createdTaskId ?? null,
       slotId: gate?.slotId ?? null,
       rowCount: rows.length,
       repoCount: repo?.querySelector(".repo-count")?.textContent?.trim() ?? "",
       rowText: row?.textContent?.trim() ?? "",
       dataTaskId: row?.getAttribute("data-task-id") || null,
       ariaBusy: row?.getAttribute("aria-busy") ?? null,
       selected: row?.classList.contains("selected") ?? false,
       sameNode: Boolean(row && gate?.originalRow && row === gate.originalRow),
       selectedItemId: unwrap(store?.selectedItemId) ?? null,
       selectedTaskId: unwrap(store?.selectedTaskId) ?? null,
       currentSlotState: currentSlot?.state ?? null,
       currentSlotTaskId: currentSlot?.task_id ?? null,
       currentSlotHasTask: Boolean(currentSlot?.task),
       durableItemPresent: Boolean(
         gate?.responseTaskId && items.some((item) => item.id === gate.responseTaskId)
       ),
       observerSamples: gate?.samples?.length ?? 0,
       observerViolations: Array.from(gate?.violations ?? []),
     };`,
  );
}

describe("task lifecycle", () => {
  const client = new WebDriverClient();
  let repoId = "";
  let fixtureRepoRoot = "";
  let secondaryFixtureRepoRoot = "";
  let testRepoPath = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    fixtureRepoRoot = await createFixtureRepo("lifecycle-test");
    testRepoPath = fixtureRepoRoot;
    repoId = await importTestRepo(client, testRepoPath, "lifecycle-test");
  });

  afterAll(async () => {
    if (testRepoPath) {
      await cleanupWorktrees(client, testRepoPath);
    }
    await cleanupFixtureRepos(
      [fixtureRepoRoot, secondaryFixtureRepoRoot].filter((path) => path.length > 0),
    );
    await client.deleteSession();
  });

  it("creates a task that appears in sidebar", async () => {
    // Internal setup only: lifecycle assertions need deterministic SDK-mode
    // tasks so closing behavior can be tested without launching a real agent.
    await waitForCondition(
      async () => client.executeSync<boolean>(
        `const repo = document.querySelector(${JSON.stringify(`.repo-section[data-repo-id="${repoId}"]`)});
         const rows = repo ? Array.from(repo.querySelectorAll(".workflow-item")) : [];
         return rows.length > 0 && rows.every((row) => row.getAttribute("aria-busy") !== "true");`,
      ),
      "repository setup task to settle before the creation handoff test",
      30_000,
    );
    const baseline = await client.executeSync<{ rowCount: number; repoCount: string }>(
      `const repo = document.querySelector(${JSON.stringify(`.repo-section[data-repo-id="${repoId}"]`)});
       return {
         rowCount: repo?.querySelectorAll(".workflow-item").length ?? 0,
         repoCount: repo?.querySelector(".repo-count")?.textContent?.trim() ?? "",
       };`,
    );
    expect(baseline.repoCount).toBe(String(baseline.rowCount));
    const expectedRowCount = baseline.rowCount + 1;
    const expectedRepoCount = String(expectedRowCount);

    try {
      await client.executeSync(
        `const originalFetch = globalThis.fetch;
       const callOriginalFetch = originalFetch.bind(globalThis);
       let releaseCreateResponse;
       let releaseSnapshotResponses;
       const createResponseGate = new Promise((resolve) => { releaseCreateResponse = resolve; });
       const snapshotResponseGate = new Promise((resolve) => { releaseSnapshotResponses = resolve; });
       const gate = {
         originalFetch,
         createResponseHeld: false,
         createResponseReleased: false,
         responseTaskId: null,
         snapshotResponsesHeld: 0,
         snapshotResponsesHeldAfterCreateRelease: 0,
         snapshotResponsesReleased: false,
         creationStatus: "pending",
         creationError: null,
         createdTaskId: null,
         creationPromise: null,
         slotId: null,
         expectedRowCount: ${expectedRowCount},
         expectedRepoCount: ${JSON.stringify(expectedRepoCount)},
         originalRow: null,
         observer: null,
         record: null,
         samples: [],
         violations: [],
         releaseCreateResponse() {
           if (this.createResponseReleased) return;
           this.createResponseReleased = true;
           releaseCreateResponse();
         },
         releaseSnapshotResponses() {
           if (this.snapshotResponsesReleased) return;
           this.snapshotResponsesReleased = true;
           releaseSnapshotResponses();
         },
       };
       window.__KANNA_TASK_CREATION_GATE__ = gate;
       globalThis.fetch = async (input, init) => {
         const url = typeof input === "string"
           ? input
           : input instanceof URL
             ? input.href
             : input.url;
         const method = String(
           init?.method ?? (input instanceof Request ? input.method : "GET")
         ).toUpperCase();
         const path = new URL(url, window.location.href).pathname;
         let requestBody = null;
         if (method === "POST" && path === "/v1/tasks" && typeof init?.body === "string") {
           try {
             requestBody = JSON.parse(init.body);
           } catch {
             requestBody = null;
           }
         }
         const isTargetCreate = method === "POST"
           && path === "/v1/tasks"
           && requestBody?.repoId === ${JSON.stringify(repoId)}
           && requestBody?.prompt === "Say OK";
         const snapshotStartedAfterCreateRelease = gate.createResponseReleased;
         const shouldHoldSnapshot = method === "GET"
           && path === "/v1/snapshot";
         const response = await callOriginalFetch(input, init);

         if (isTargetCreate) {
           const body = await response.clone().json().catch(() => null);
           gate.responseTaskId = typeof body?.taskId === "string" ? body.taskId : null;
           gate.createResponseHeld = true;
           await createResponseGate;
         } else if (shouldHoldSnapshot) {
           gate.snapshotResponsesHeld += 1;
           if (snapshotStartedAfterCreateRelease) {
             gate.snapshotResponsesHeldAfterCreateRelease += 1;
           }
           await snapshotResponseGate;
         }

         return response;
       };
       return true;`,
      );

      await client.executeSync(
        `const gate = window.__KANNA_TASK_CREATION_GATE__;
         const ctx = window.__KANNA_E2E__.setupState;
         gate.creationPromise = Promise.resolve(
           ctx.createItem(${JSON.stringify(repoId)}, ${JSON.stringify(testRepoPath)}, "Say OK", "agent")
         ).then((taskId) => {
           gate.creationStatus = "fulfilled";
           gate.createdTaskId = taskId;
           return taskId;
         }).catch((error) => {
           gate.creationStatus = "rejected";
           gate.creationError = error?.message || String(error);
           throw error;
         });
         void gate.creationPromise.catch(() => undefined);
         return true;`,
      );

      await waitForCondition(
        async () => client.executeSync<boolean>(
          `const gate = window.__KANNA_TASK_CREATION_GATE__;
           const ctx = window.__KANNA_E2E__.setupState;
           const unwrap = (value) => value && value.__v_isRef ? value.value : value;
           const selectedSlotId = unwrap(ctx.store?.selectedItemId) ?? null;
           const repo = document.querySelector(${JSON.stringify(`.repo-section[data-repo-id="${repoId}"]`)});
           const rows = repo ? Array.from(repo.querySelectorAll(".workflow-item")) : [];
           const row = rows.find((candidate) => candidate.dataset.slotId === selectedSlotId) ?? null;
           return rows.length === gate.expectedRowCount && Boolean(row?.dataset.slotId);`,
        ),
        "optimistic task sidebar slot",
        30_000,
      );

      const captured = await client.executeSync<{ slotId: string; rowCount: number; repoCount: string }>(
        `const gate = window.__KANNA_TASK_CREATION_GATE__;
         const ctx = window.__KANNA_E2E__.setupState;
         const unwrap = (value) => value && value.__v_isRef ? value.value : value;
         const selectedSlotId = unwrap(ctx.store?.selectedItemId) ?? null;
         const repo = document.querySelector(${JSON.stringify(`.repo-section[data-repo-id="${repoId}"]`)});
         const rows = repo ? Array.from(repo.querySelectorAll(".workflow-item")) : [];
         const row = rows.find((candidate) => candidate.dataset.slotId === selectedSlotId) ?? null;
         if (!repo || rows.length !== gate.expectedRowCount || !row?.dataset.slotId) {
           throw new Error("expected one additional selected optimistic task slot before capturing its DOM identity");
         }
         gate.slotId = row.dataset.slotId;
         gate.originalRow = row;
         gate.record = () => {
           const currentRows = Array.from(repo.querySelectorAll(".workflow-item"));
           const repoCount = repo.querySelector(".repo-count")?.textContent?.trim() ?? "";
           const currentRow = currentRows.find(
             (candidate) => candidate.dataset.slotId === gate.slotId
           ) ?? null;
           const sample = {
             rowCount: currentRows.length,
             repoCount,
             sameNode: currentRow === gate.originalRow,
             dataTaskId: currentRow?.getAttribute("data-task-id") || null,
           };
           gate.samples.push(sample);
           const noteViolation = (message) => {
             if (!gate.violations.includes(message)) gate.violations.push(message);
           };
           if (sample.rowCount !== gate.expectedRowCount) noteViolation("row-count:" + sample.rowCount);
           if (sample.repoCount !== gate.expectedRepoCount) noteViolation("repo-count:" + sample.repoCount);
           if (!sample.sameNode) noteViolation("slot-dom-node-replaced");
         };
         gate.observer = new MutationObserver(() => gate.record());
         gate.observer.observe(repo, {
           attributes: true,
           characterData: true,
           childList: true,
           subtree: true,
         });
         gate.record();
         return {
           slotId: gate.slotId,
           rowCount: rows.length,
           repoCount: repo.querySelector(".repo-count")?.textContent?.trim() ?? "",
         };`,
      );
      expect(captured.slotId).toMatch(/^create:/);
      expect(captured.rowCount).toBe(expectedRowCount);
      expect(captured.repoCount).toBe(expectedRepoCount);

      await waitForCondition(
        async () => {
          const state = await getTaskCreationE2eState(client, repoId);
          return state.createResponseHeld || state.creationStatus === "rejected";
        },
        "completed server response held before frontend acknowledgement",
        30_000,
      );

      const optimistic = await getTaskCreationE2eState(client, repoId);
      expect(optimistic.creationError).toBeNull();
      expect(optimistic.createResponseHeld).toBe(true);
      expect(optimistic.responseTaskId).toBeTruthy();
      expect(optimistic.rowCount).toBe(expectedRowCount);
      expect(optimistic.repoCount).toBe(expectedRepoCount);
      expect(optimistic.rowText).toContain("Say OK");
      expect(optimistic.slotId).toBe(captured.slotId);
      expect(optimistic.dataTaskId).toBeNull();
      expect(optimistic.ariaBusy).toBe("true");
      expect(optimistic.selected).toBe(true);
      expect(optimistic.sameNode).toBe(true);
      expect(optimistic.selectedItemId).toBe(captured.slotId);
      expect(optimistic.selectedTaskId).toBeNull();
      expect(optimistic.currentSlotState).toBe("creating");
      expect(optimistic.currentSlotTaskId).toBeNull();
      expect(optimistic.currentSlotHasTask).toBe(false);

      await client.executeSync(
        `window.__KANNA_TASK_CREATION_GATE__.releaseCreateResponse(); return true;`,
      );

      await waitForCondition(
        async () => {
          const state = await getTaskCreationE2eState(client, repoId);
          return state.creationStatus === "rejected" || (
            state.dataTaskId === state.responseTaskId
            && state.currentSlotState === "creating"
            && state.snapshotResponsesHeldAfterCreateRelease > 0
          );
        },
        "acknowledged creating slot with its hydration snapshot held",
        15_000,
      );

      const acknowledged = await getTaskCreationE2eState(client, repoId);
      expect(acknowledged.creationError).toBeNull();
      expect(acknowledged.creationStatus).toBe("pending");
      expect(acknowledged.rowCount).toBe(expectedRowCount);
      expect(acknowledged.repoCount).toBe(expectedRepoCount);
      expect(acknowledged.slotId).toBe(captured.slotId);
      expect(acknowledged.dataTaskId).toBe(acknowledged.responseTaskId);
      expect(acknowledged.ariaBusy).toBe("true");
      expect(acknowledged.selected).toBe(true);
      expect(acknowledged.sameNode).toBe(true);
      expect(acknowledged.selectedItemId).toBe(captured.slotId);
      expect(acknowledged.selectedTaskId).toBe(acknowledged.responseTaskId);
      expect(acknowledged.currentSlotState).toBe("creating");
      expect(acknowledged.currentSlotTaskId).toBe(acknowledged.responseTaskId);
      expect(acknowledged.currentSlotHasTask).toBe(false);
      expect(acknowledged.snapshotResponsesHeldAfterCreateRelease).toBeGreaterThan(0);

      await client.executeSync(
        `window.__KANNA_TASK_CREATION_GATE__.releaseSnapshotResponses(); return true;`,
      );

      await waitForCondition(
        async () => {
          const state = await getTaskCreationE2eState(client, repoId);
          return state.creationStatus === "rejected" || (
            state.creationStatus === "fulfilled"
            && state.currentSlotState === "ready"
            && state.currentSlotHasTask
          );
        },
        "hydrated durable task in the original sidebar slot",
        15_000,
      );

      const hydrated = await getTaskCreationE2eState(client, repoId);
      expect(hydrated.creationError).toBeNull();
      expect(hydrated.creationStatus).toBe("fulfilled");
      expect(hydrated.createdTaskId).toBe(hydrated.responseTaskId);
      expect(hydrated.rowCount).toBe(expectedRowCount);
      expect(hydrated.repoCount).toBe(expectedRepoCount);
      expect(hydrated.rowText).toContain("Say OK");
      expect(hydrated.slotId).toBe(captured.slotId);
      expect(hydrated.dataTaskId).toBe(hydrated.responseTaskId);
      expect(hydrated.ariaBusy).toBeNull();
      expect(hydrated.selected).toBe(true);
      expect(hydrated.sameNode).toBe(true);
      expect(hydrated.selectedItemId).toBe(captured.slotId);
      expect(hydrated.selectedTaskId).toBe(hydrated.responseTaskId);
      expect(hydrated.currentSlotState).toBe("ready");
      expect(hydrated.currentSlotTaskId).toBe(hydrated.responseTaskId);
      expect(hydrated.currentSlotHasTask).toBe(true);
      expect(hydrated.durableItemPresent).toBe(true);
      expect(hydrated.observerSamples).toBeGreaterThan(0);
      expect(hydrated.observerViolations).toEqual([]);
    } finally {
      await client.executeSync(
        `const gate = window.__KANNA_TASK_CREATION_GATE__;
         if (gate) {
           gate.observer?.disconnect();
           gate.releaseCreateResponse?.();
           gate.releaseSnapshotResponses?.();
           globalThis.fetch = gate.originalFetch;
         }
         return true;`,
      ).catch(() => undefined);
      await client.executeAsync<string>(
        `const cb = arguments[arguments.length - 1];
         const promise = window.__KANNA_TASK_CREATION_GATE__?.creationPromise;
         Promise.resolve(promise).catch(() => undefined).then(() => cb("settled"));`,
      ).catch(() => undefined);
      await client.executeSync(
        `delete window.__KANNA_TASK_CREATION_GATE__; return true;`,
      ).catch(() => undefined);
    }
  });

  it("shows task header with prompt text", async () => {
    const el = await client.waitForText(".task-header", "Say OK");
    expect(el).toBeTruthy();
  });

  it("creates the task worktree", async () => {
    const rows = (await queryDb(
      client,
      "SELECT branch FROM pipeline_item WHERE repo_id = ? AND prompt = ? ORDER BY created_at DESC LIMIT 1",
      [repoId, "Say OK"],
    )) as Array<{ branch: string | null }>;
    const branch = rows[0]?.branch ?? null;
    expect(branch).toBeTruthy();
    if (!branch) {
      throw new Error("expected the created task to have a branch");
    }

    const exists = await tauriInvoke(client, "file_exists", {
      path: `${testRepoPath}/.kanna-worktrees/${branch}`,
    });
    expect(exists).toBe(true);
  });

  it("launches a new PTY task with runtime guidance without persisting or displaying it as the user prompt", async () => {
    const prompt = "Inspect the runtime guidance launch path";
    const createResult = await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       const ctx = window.__KANNA_E2E__.setupState;
       window.__KANNA_E2E__.invokes.clear();
       ctx.createItem(${JSON.stringify(repoId)}, ${JSON.stringify(testRepoPath)}, ${JSON.stringify(prompt)}, "pty", {
         agentProvider: "codex",
       })
         .then(() => cb("ok"))
         .catch((error) => cb("err:" + error));`
    );
    expect(createResult).toBe("ok");

    const rows = (await queryDb(
      client,
      "SELECT id, prompt, agent_provider, agent_type FROM pipeline_item WHERE repo_id = ? AND prompt = ? ORDER BY created_at DESC LIMIT 1",
      [repoId, prompt],
    )) as Array<{ id: string; prompt: string; agent_provider: string; agent_type: string }>;
    expect(rows[0]?.prompt).toBe(prompt);
    expect(rows[0]?.agent_provider).toBe("codex");
    expect(rows[0]?.agent_type).toBe("pty");

    const firstTaskRows = (await queryDb(
      client,
      "SELECT id FROM pipeline_item WHERE repo_id = ? AND prompt = ? ORDER BY created_at DESC LIMIT 1",
      [repoId, "Say OK"],
    )) as Array<{ id: string }>;
    await callVueMethod(client, "store.selectItem", firstTaskRows[0]?.id);

    // The server-backed create path owns PTY spawn construction. This E2E
    // verifies the browser-visible contract: the persisted prompt remains the
    // user prompt and the task can be selected without exposing runtime
    // guidance in the task title/header.
    const sidebarText = await client.executeSync<string>(
      `return document.querySelector(".sidebar")?.textContent || "";`,
    );
    expect(sidebarText).toContain(prompt);
    expect(sidebarText).not.toMatch(/This\s+session\s+was\s+launched\s+by\s+Kanna/);
  });

  it("keeps a task visible while teardown is in progress", async () => {
    const rows = (await queryDb(
      client,
      "SELECT id, branch FROM pipeline_item WHERE repo_id = ? AND prompt = ? ORDER BY created_at DESC LIMIT 1",
      [repoId, "Say OK"],
    )) as Array<{ id: string; branch: string }>;
    const taskId = rows[0]?.id;
    const branch = rows[0]?.branch;
    expect(taskId).toBeTruthy();
    expect(branch).toBeTruthy();
    if (!taskId || !branch) {
      throw new Error("expected the created task to have a branch");
    }

    await execDb(
      client,
      "UPDATE pipeline_item SET teardown_started_at = datetime('now') WHERE id = ?",
      [taskId],
    );
    await client.executeSync(
      `const ctx = window.__KANNA_E2E__.setupState;
       const items = ctx.store?.items?.value ?? ctx.store?.items;
       const item = Array.isArray(items) ? items.find((candidate) => candidate.id === ${JSON.stringify(taskId)}) : null;
       if (item) item.teardown_started_at = new Date().toISOString();
       return true;`,
    );

    const stageRow = await waitForPipelineItem<{ stage: string; teardown_started_at: string | null }>(
      client,
      "SELECT stage, teardown_started_at FROM pipeline_item WHERE repo_id = ? AND prompt = ? ORDER BY created_at DESC LIMIT 1",
      [repoId, "Say OK"],
      (row) => row?.stage === "in progress" && Boolean(row.teardown_started_at),
    );
    expect(stageRow.stage).toBe("in progress");
    expect(stageRow.teardown_started_at).toBeTruthy();

    const sidebarText = await client.executeSync<string>(
      `return document.querySelector(".sidebar")?.textContent || "";`
    );
    expect(sidebarText).toContain("Say OK");
    expect(sidebarText).not.toContain("teardown");

    const titleStyle = await client.executeSync<string>(
      `const titles = Array.from(document.querySelectorAll(".workflow-item .item-title"));
       const title = titles.find((el) => (el.textContent || "").includes("Say OK"));
       return title ? window.getComputedStyle(title).textDecorationLine : "";`
    );
    expect(titleStyle).toContain("line-through");
  });

  it("closes immediately and disappears when teardown commands do not exist", async () => {
    // Internal setup only: this creates a second inert task to isolate close
    // behavior from terminal and agent process startup.
    const createResult = await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       const ctx = window.__KANNA_E2E__.setupState;
       ctx.createItem(${JSON.stringify(repoId)}, ${JSON.stringify(testRepoPath)}, "Close Fast", "agent")
         .then(() => cb("ok"))
         .catch((error) => cb("err:" + error));`
    );
    expect(createResult).toBe("ok");

    const header = await client.waitForText(".task-header", "Close Fast");
    expect(header).toBeTruthy();

    const rows = (await queryDb(
      client,
      "SELECT id, branch FROM pipeline_item WHERE repo_id = ? AND prompt = ? ORDER BY created_at DESC LIMIT 1",
      [repoId, "Close Fast"],
    )) as Array<{ id: string; branch: string }>;
    const branch = rows[0]?.branch;
    expect(branch).toBeTruthy();
    if (!branch) {
      throw new Error("expected the close-fast task to have a branch");
    }

    await tauriInvoke(client, "write_text_file", {
      path: `${testRepoPath}/.kanna-worktrees/${branch}/.kanna/config.json`,
      content: JSON.stringify({ setup: [] }),
    });

    const closeResult = await callVueMethod(client, "store.closeTask");
    if (closeResult && typeof closeResult === "object" && "__error" in closeResult) {
      throw new Error(String((closeResult as { __error: unknown }).__error));
    }

    // closed_at is the sole done indicator — closing never rewrites stage.
    const closedRow = await waitForPipelineItem<{ closed_at: string | null }>(
      client,
      "SELECT closed_at FROM pipeline_item WHERE repo_id = ? AND prompt = ? ORDER BY created_at DESC LIMIT 1",
      [repoId, "Close Fast"],
      (row) => typeof row?.closed_at === "string" && row.closed_at.length > 0,
    );
    expect(closedRow.closed_at).toBeTruthy();

    const sidebarText = await client.executeSync<string>(
      `return document.querySelector(".sidebar")?.textContent || "";`
    );
    expect(sidebarText).not.toContain("Close Fast");
  });

  it("removes the selected task and presents its replacement before close resolves", async () => {
    const replacementPrompt = "Replacement visible during delayed close";
    const closingPrompt = "Optimistically hidden during delayed close";
    const createAgentTask = async (prompt: string): Promise<string> => {
      const result = await callVueMethod(
        client,
        "createItem",
        repoId,
        testRepoPath,
        prompt,
        "agent",
      );
      if (typeof result !== "string" || result.length === 0) {
        throw new Error(`failed to create task ${prompt}: ${JSON.stringify(result)}`);
      }
      return result;
    };

    const replacementTaskId = await createAgentTask(replacementPrompt);
    const closingTaskId = await createAgentTask(closingPrompt);
    await client.waitForText(".task-header", closingPrompt, 10_000);

    await client.executeSync(
      `const originalFetch = globalThis.fetch;
       const callOriginalFetch = originalFetch.bind(globalThis);
       let releaseCloseRequest;
       const closeRequestGate = new Promise((resolve) => { releaseCloseRequest = resolve; });
       const gate = {
         originalFetch,
         responseHeld: false,
         responseReleased: false,
         responseCompleted: false,
         release() {
           if (this.responseReleased) return;
           this.responseReleased = true;
           releaseCloseRequest();
         },
       };
       window.__KANNA_OPTIMISTIC_CLOSE_GATE__ = gate;
       globalThis.fetch = async (input, init) => {
         const url = typeof input === "string"
           ? input
           : input instanceof URL
             ? input.href
             : input.url;
         const method = String(
           init?.method ?? (input instanceof Request ? input.method : "GET")
         ).toUpperCase();
         const path = new URL(url, window.location.href).pathname;
         if (
           method === "POST"
           && path === ${JSON.stringify(`/v1/tasks/${encodeURIComponent(closingTaskId)}/actions/close`)}
         ) {
           gate.responseHeld = true;
           await closeRequestGate;
           const response = await callOriginalFetch(input, init);
           gate.responseCompleted = true;
           return response;
         }
         return callOriginalFetch(input, init);
       };
       return true;`,
    );

    try {
      await client.executeSync(
        buildGlobalKeydownScript({ key: "Delete", meta: true, shift: true }),
      );
      await waitForCondition(
        async () => client.executeSync<boolean>(
          `return window.__KANNA_OPTIMISTIC_CLOSE_GATE__?.responseHeld === true;`,
        ),
        "close request to be held before reaching the server",
        10_000,
      );

      const optimisticState = await client.executeSync<{
        responseReleased: boolean;
        responseCompleted: boolean;
        closingVisible: boolean;
        replacementVisible: boolean;
        selectedTaskId: string | null;
        selectedTitle: string;
        header: string;
      }>(
        `const gate = window.__KANNA_OPTIMISTIC_CLOSE_GATE__;
         const closing = document.querySelector(${JSON.stringify(`.workflow-item[data-task-id="${closingTaskId}"]`)});
         const replacement = document.querySelector(${JSON.stringify(`.workflow-item[data-task-id="${replacementTaskId}"]`)});
         const selected = document.querySelector(".workflow-item.selected");
         return {
           responseReleased: gate?.responseReleased === true,
           responseCompleted: gate?.responseCompleted === true,
           closingVisible: Boolean(closing),
           replacementVisible: Boolean(replacement),
           selectedTaskId: selected?.getAttribute("data-task-id") || null,
           selectedTitle: selected?.querySelector(".item-title")?.textContent?.trim() ?? "",
           header: document.querySelector(".task-header")?.textContent?.trim() ?? "",
         };`,
      );
      expect(optimisticState).toMatchObject({
        responseReleased: false,
        responseCompleted: false,
        closingVisible: false,
        replacementVisible: true,
      });
      expect(optimisticState.selectedTaskId).toBeTruthy();
      expect(optimisticState.selectedTaskId).not.toBe(closingTaskId);
      expect(optimisticState.selectedTitle.length).toBeGreaterThan(0);
      expect(optimisticState.header).toContain(optimisticState.selectedTitle);
      expect(optimisticState.header).not.toContain(closingPrompt);

      await client.executeSync(
        `window.__KANNA_OPTIMISTIC_CLOSE_GATE__.release(); return true;`,
      );
      await waitForCondition(
        async () => client.executeSync<boolean>(
          `return window.__KANNA_OPTIMISTIC_CLOSE_GATE__?.responseCompleted === true;`,
        ),
        "authoritative close response",
        15_000,
      );
      const closedRow = await waitForPipelineItem<{ closed_at: string | null }>(
        client,
        "SELECT closed_at FROM pipeline_item WHERE id = ?",
        [closingTaskId],
        (row) => typeof row?.closed_at === "string" && row.closed_at.length > 0,
        15_000,
      );
      expect(closedRow.closed_at).toBeTruthy();

      const completedState = await client.executeSync<{
        closingVisible: boolean;
        selectedTaskId: string | null;
        header: string;
      }>(
        `const closing = document.querySelector(${JSON.stringify(`.workflow-item[data-task-id="${closingTaskId}"]`)});
         const selected = document.querySelector(".workflow-item.selected");
         return {
           closingVisible: Boolean(closing),
           selectedTaskId: selected?.getAttribute("data-task-id") || null,
           header: document.querySelector(".task-header")?.textContent?.trim() ?? "",
         };`,
      );
      expect(completedState).toEqual({
        closingVisible: false,
        selectedTaskId: optimisticState.selectedTaskId,
        header: optimisticState.header,
      });
    } finally {
      await client.executeSync(
        `const gate = window.__KANNA_OPTIMISTIC_CLOSE_GATE__;
         if (gate) {
           gate.release?.();
           globalThis.fetch = gate.originalFetch;
         }
         delete window.__KANNA_OPTIMISTIC_CLOSE_GATE__;
         return true;`,
      ).catch(() => undefined);
      for (const taskId of [closingTaskId, replacementTaskId]) {
        await callVueMethod(client, "store.closeTask", taskId, { selectNext: false })
          .catch(() => undefined);
      }
    }
  });

  it("keeps a closed active-stage task out of sidebar selection and terminal startup after reload", async () => {
    const openTaskId = "task-open-active-e2e";
    const closedTaskId = "task-e24fce1c";
    const openBranch = "task-open-active-e2e";
    const closedBranch = "task-e24fce1c";

    await seedPtyTask(client, {
      id: openTaskId,
      repoId,
      prompt: "Visible open task after reload",
      stage: "in progress",
      branch: openBranch,
      closedAt: null,
      createdAt: "2099-06-03T01:00:00.000Z",
    });
    await seedPtyTask(client, {
      id: closedTaskId,
      repoId,
      prompt: "Closed active-stage task should stay hidden",
      stage: "pr",
      branch: closedBranch,
      closedAt: "2026-06-03T01:05:00.000Z",
      createdAt: "2099-06-03T02:00:00.000Z",
    });
    await tauriInvoke(client, "ensure_directory", {
      path: `${testRepoPath}/.kanna-worktrees/${openBranch}`,
    });
    await execDb(
      client,
      `INSERT INTO terminal_session (id, repo_id, pipeline_item_id, label, cwd, daemon_session_id, created_at)
       VALUES (?, ?, ?, 'claude', ?, NULL, ?)`,
      [
        `ts-${closedTaskId}`,
        repoId,
        closedTaskId,
        `${testRepoPath}/.kanna-worktrees/${closedBranch}`,
        "2026-06-03T02:00:00.000Z",
      ],
    );
    await persistWindowSelection(client, { repoId, itemId: closedTaskId });
    await client.executeSync("window.__KANNA_E2E__.appMetrics.clear(); location.reload();");
    await client.waitForAppReady();

    await waitForCondition(async () => {
      const selectedItemId = await getVueState(client, "selectedItemId");
      const currentItem = await getVueState(client, "currentItem") as { id?: string | null } | null;
      return selectedItemId !== closedTaskId && currentItem?.id === openTaskId;
    }, "closed task to be excluded from selection and current item after reload", 10_000);

    const state = await client.executeSync<{
      selectedItemId: string | null;
      currentItemId: string | null;
      currentItemPrompt: string | null;
      itemIds: string[];
    }>(
      `const ctx = window.__KANNA_E2E__.setupState;
       const read = (value) => value && value.__v_isRef ? value.value : value;
       const currentItem = read(ctx.store.currentItem);
       return {
         selectedItemId: read(ctx.store.selectedItemId),
         currentItemId: currentItem?.id ?? null,
         currentItemPrompt: currentItem?.prompt ?? null,
         itemIds: read(ctx.store.items).map((item) => item.id),
       };`,
    );
    expect(state).toMatchObject({
      currentItemId: openTaskId,
      currentItemPrompt: "Visible open task after reload",
      itemIds: expect.arrayContaining([openTaskId]),
    });
    expect(state.selectedItemId).not.toBe(closedTaskId);
    expect(state.itemIds).not.toContain(closedTaskId);

    const sidebarText = await client.executeSync<string>(
      `return document.querySelector(".sidebar")?.textContent || "";`,
    );
    expect(sidebarText).toContain("Visible open task after reload");
    expect(sidebarText).not.toContain("Closed active-stage task should stay hidden");

    await client.waitForElement(".main-panel .terminal-container", 10_000);
    await waitForCondition(async () => {
      const text = await client.executeSync<string>(
        `return document.querySelector(".main-panel")?.textContent || "";`,
      );
      return text.includes(openTaskId);
    }, "open task terminal output", 10_000);

    const mainPanelText = await client.executeSync<string>(
      `return document.querySelector(".main-panel")?.textContent || "";`,
    );
    expect(mainPanelText).toContain(openTaskId);
    expect(mainPanelText).not.toContain(closedTaskId);

    const metrics = await getAppInvokeMetrics(client);
    expect(metrics.invokeCounts.spawn_session ?? 0).toBeGreaterThanOrEqual(1);
    expect(metrics.invokeCalls).toBeDefined();

    const callsForClosedTask = (metrics.invokeCalls ?? []).filter((call) =>
      JSON.stringify(call).includes(closedTaskId)
      || JSON.stringify(call).includes(closedBranch)
    );
    expect(callsForClosedTask).toEqual([]);
  });

  it("keeps dependents with resolved hidden blockers out of the Blocked section after snapshot hydration", async () => {
    const dependentTaskId = "task-resolved-blocker-dependent-e2e";
    const closedBlockerTaskId = "task-resolved-closed-blocker-e2e";
    const prBlockerTaskId = "task-resolved-pr-blocker-e2e";
    const hiddenRepoId = "repo-resolved-pr-blocker-e2e";

    await execDb(
      client,
      `INSERT INTO repo (id, path, name, default_branch, hidden, sort_order, created_at, last_opened_at)
       VALUES (?, ?, ?, 'main', 1, 99, ?, ?)`,
      [
        hiddenRepoId,
        "/tmp/kanna-resolved-pr-blocker-e2e",
        "Hidden resolved blocker repo",
        "2026-07-20T00:00:00.000Z",
        "2026-07-20T00:00:00.000Z",
      ],
    );
    await seedPtyTask(client, {
      id: dependentTaskId,
      repoId,
      prompt: "Dependent with resolved blockers",
      stage: "in progress",
      branch: dependentTaskId,
      closedAt: null,
      createdAt: "2100-07-20T03:00:00.000Z",
    });
    await seedPtyTask(client, {
      id: closedBlockerTaskId,
      repoId,
      prompt: "Closed blocker absent from visible snapshot items",
      stage: "review",
      branch: closedBlockerTaskId,
      closedAt: "2026-07-20T01:00:00.000Z",
      createdAt: "2100-07-20T02:00:00.000Z",
    });
    await seedPtyTask(client, {
      id: prBlockerTaskId,
      repoId: hiddenRepoId,
      prompt: "PR blocker absent with its hidden repository",
      stage: "pr",
      branch: prBlockerTaskId,
      closedAt: null,
      createdAt: "2100-07-20T01:00:00.000Z",
    });
    await execDb(
      client,
      "UPDATE pipeline_item SET pr_url = ? WHERE id = ?",
      ["https://github.com/kanna-test/kanna-test/pull/42", prBlockerTaskId],
    );
    await execDb(
      client,
      "INSERT INTO task_blocker (blocked_item_id, blocker_item_id) VALUES (?, ?), (?, ?)",
      [dependentTaskId, closedBlockerTaskId, dependentTaskId, prBlockerTaskId],
    );

    const { baseUrl } = await resolveAppKannaServer(client);
    const response = await localProcessFetch(`${baseUrl}/v1/snapshot`);
    expect(response.status).toBe(200);
    const snapshot = await response.json() as {
      entries: Array<{ items: Array<{ id: string }> }>;
      taskBlockers: Array<{ blocked_item_id: string; blocker_item_id: string }>;
      blockerTaskStates: Record<string, {
        closed_at: string | null;
        stage: string | null;
        pr_url: string | null;
      }>;
    };
    const snapshotItemIds = snapshot.entries.flatMap((entry) => entry.items.map((item) => item.id));
    expect(snapshotItemIds).toContain(dependentTaskId);
    expect(snapshotItemIds).not.toContain(closedBlockerTaskId);
    expect(snapshotItemIds).not.toContain(prBlockerTaskId);
    expect(snapshot.taskBlockers).toEqual(expect.arrayContaining([
      { blocked_item_id: dependentTaskId, blocker_item_id: closedBlockerTaskId },
      { blocked_item_id: dependentTaskId, blocker_item_id: prBlockerTaskId },
    ]));
    expect(snapshot.blockerTaskStates[closedBlockerTaskId]?.closed_at).toBe(
      "2026-07-20T01:00:00.000Z",
    );
    expect(snapshot.blockerTaskStates[prBlockerTaskId]).toMatchObject({
      closed_at: null,
      stage: "pr",
      pr_url: "https://github.com/kanna-test/kanna-test/pull/42",
    });

    await persistWindowSelection(client, { repoId, itemId: dependentTaskId });
    await client.executeSync("location.reload();");
    await client.waitForAppReady();
    await waitForCondition(
      async () => client.executeSync<boolean>(
        `const ctx = window.__KANNA_E2E__.setupState;
         const read = (value) => value && value.__v_isRef ? value.value : value;
         const currentItem = read(ctx.store.currentItem);
         const row = document.querySelector(${JSON.stringify(
           `.repo-section[data-repo-id="${repoId}"] .workflow-item[data-task-id="${dependentTaskId}"]`,
         )});
         const sectionLabel = row?.closest(".type-zone")?.previousElementSibling?.textContent?.trim() ?? null;
         return currentItem?.id === ${JSON.stringify(dependentTaskId)}
           && sectionLabel === "in progress";`,
      ),
      "resolved-blocker dependent to hydrate in its normal stage",
      10_000,
      async () => client.executeSync(
        `const ctx = window.__KANNA_E2E__.setupState;
         const read = (value) => value && value.__v_isRef ? value.value : value;
         const row = document.querySelector(${JSON.stringify(
           `.repo-section[data-repo-id="${repoId}"] .workflow-item[data-task-id="${dependentTaskId}"]`,
         )});
         return {
           selectedItemId: read(ctx.store.selectedItemId),
           currentItemId: read(ctx.store.currentItem)?.id ?? null,
           rowFound: row !== null,
           sectionLabel: row?.closest(".type-zone")?.previousElementSibling?.textContent?.trim() ?? null,
           sidebarText: document.querySelector(".sidebar")?.textContent ?? "",
           blockedPlaceholderVisible: document.querySelector(".main-panel .blocked-placeholder") !== null,
         };`,
      ),
    );

    const hydrated = await client.executeSync<{
      selectedItemId: string | null;
      currentItemId: string | null;
      itemIds: string[];
      blockerStates: Record<string, { closed_at: string | null; stage: string | null; pr_url: string | null }>;
      sectionLabel: string | null;
      mainPanelText: string;
      blockedPlaceholderVisible: boolean;
    }>(
      `const ctx = window.__KANNA_E2E__.setupState;
       const read = (value) => value && value.__v_isRef ? value.value : value;
       const currentItem = read(ctx.store.currentItem);
       const row = document.querySelector(${JSON.stringify(
         `.repo-section[data-repo-id="${repoId}"] .workflow-item[data-task-id="${dependentTaskId}"]`,
       )});
       return {
         selectedItemId: read(ctx.store.selectedItemId),
         currentItemId: currentItem?.id ?? null,
         itemIds: read(ctx.store.items).map((item) => item.id),
         blockerStates: JSON.parse(JSON.stringify(read(ctx.store.blockerTaskStates))),
         sectionLabel: row?.closest(".type-zone")?.previousElementSibling?.textContent?.trim() ?? null,
         mainPanelText: document.querySelector(".main-panel")?.textContent ?? "",
         blockedPlaceholderVisible: document.querySelector(".main-panel .blocked-placeholder") !== null,
       };`,
    );
    expect(hydrated).toMatchObject({
      selectedItemId: dependentTaskId,
      currentItemId: dependentTaskId,
      sectionLabel: "in progress",
      blockedPlaceholderVisible: false,
    });
    expect(hydrated.itemIds).toContain(dependentTaskId);
    expect(hydrated.itemIds).not.toContain(closedBlockerTaskId);
    expect(hydrated.itemIds).not.toContain(prBlockerTaskId);
    expect(hydrated.blockerStates[closedBlockerTaskId]?.closed_at).toBe(
      "2026-07-20T01:00:00.000Z",
    );
    expect(hydrated.blockerStates[prBlockerTaskId]?.pr_url).toBe(
      "https://github.com/kanna-test/kanna-test/pull/42",
    );
    expect(hydrated.mainPanelText).toContain("Dependent with resolved blockers");
  });

  it("keeps the current repo selected when closing its only task while another repo has a task", async () => {
    await resetDatabase(client);
    secondaryFixtureRepoRoot = await createFixtureRepo("lifecycle-secondary-test");

    const importRepo = async (path: string, name: string): Promise<string> => {
      const result = await callVueMethod(client, "store.importRepo", path, name, "main");
      if (typeof result !== "string" || result.length === 0) {
        throw new Error(`failed to import ${name}: ${JSON.stringify(result)}`);
      }
      return result;
    };

    const repoAId = await importRepo(testRepoPath, "close-empty-repo-a");
    const repoBId = await importRepo(secondaryFixtureRepoRoot, "close-empty-repo-b");
    let repoATaskId = "";
    let repoBTaskId = "";
    let delayedRepoATaskId = "";
    let createdDuringCloseTaskId = "";

    const createAgentTask = async (
      targetRepoId: string,
      repoPath: string,
      prompt: string,
    ): Promise<string> => {
      const result = await callVueMethod(
        client,
        "createItem",
        targetRepoId,
        repoPath,
        prompt,
        "agent",
      );
      if (typeof result !== "string" || result.length === 0) {
        throw new Error(`failed to create task ${prompt}: ${JSON.stringify(result)}`);
      }
      return result;
    };

    const assertEmptyRepoASelection = async (repoBTaskId: string): Promise<void> => {
      const state = await client.executeSync<{
        selectedRepoId: string | null;
        selectedItemId: string | null;
        repoASelected: boolean;
        repoAEmptyText: string;
        repoATaskCount: number;
        repoBTaskSelected: boolean;
        mainPanelText: string;
      }>(
        `const ctx = window.__KANNA_E2E__.setupState;
         const read = (value) => value && value.__v_isRef ? value.value : value;
         const repoA = document.querySelector(${JSON.stringify(`.repo-section[data-repo-id="${repoAId}"]`)});
         const repoBTask = document.querySelector(${JSON.stringify(`.repo-section[data-repo-id="${repoBId}"] .workflow-item[data-task-id="${repoBTaskId}"]`)});
         return {
           selectedRepoId: read(ctx.store.selectedRepoId) ?? null,
           selectedItemId: read(ctx.store.selectedItemId) ?? null,
           repoASelected: repoA?.querySelector(".repo-header")?.classList.contains("selected") ?? false,
           repoAEmptyText: repoA?.querySelector(".no-items")?.textContent?.trim() ?? "",
           repoATaskCount: repoA?.querySelectorAll(".workflow-item").length ?? -1,
           repoBTaskSelected: repoBTask?.classList.contains("selected") ?? false,
           mainPanelText: document.querySelector(".main-panel .empty-state")?.textContent?.trim() ?? "",
         };`,
      );

      expect(state).toEqual({
        selectedRepoId: repoAId,
        selectedItemId: null,
        repoASelected: true,
        repoAEmptyText: "No tasks",
        repoATaskCount: 0,
        repoBTaskSelected: false,
        mainPanelText: expect.stringContaining("No task selected"),
      });
    };

    try {
      repoATaskId = await createAgentTask(
        repoAId,
        testRepoPath,
        "Only task in repository A",
      );
      repoBTaskId = await createAgentTask(
        repoBId,
        secondaryFixtureRepoRoot,
        "Open task in repository B",
      );

      await callVueMethod(client, "store.selectRepo", repoAId);
      await callVueMethod(client, "store.selectItem", repoATaskId);
      await persistWindowSelection(client, { repoId: repoAId, itemId: repoATaskId });

      await client.executeSync(
        `const originalFetch = globalThis.fetch;
         window.__KANNA_FIRST_CLOSE_FETCH__ = originalFetch;
         globalThis.fetch = async (input, init) => {
           const url = typeof input === "string"
             ? input
             : input instanceof URL
               ? input.href
               : input.url;
           const method = String(
             init?.method ?? (input instanceof Request ? input.method : "GET")
           ).toUpperCase();
           const response = await originalFetch(input, init);
           const path = new URL(url, window.location.href).pathname;
           if (
             method === "POST"
             && path === ${JSON.stringify(`/v1/tasks/${encodeURIComponent(repoATaskId)}/actions/close`)}
           ) {
             return new Response("simulated lost close response", {
               status: 503,
               statusText: "Service Unavailable",
             });
           }
           return response;
         };
         return true;`,
      );

      let closeResult: unknown;
      try {
        closeResult = await callVueMethod(client, "closeSelectedWorkspaceTask");
      } finally {
        await client.executeSync(
          `globalThis.fetch = window.__KANNA_FIRST_CLOSE_FETCH__;
           delete window.__KANNA_FIRST_CLOSE_FETCH__;
           return true;`,
        );
      }
      expect(closeResult).toBe(true);

      const closeState = await client.executeAsync<{
        closedAt: string | null;
        selectedRepoId: string | null;
        selectedItemId: string | null;
      }>(
        `const cb = arguments[arguments.length - 1];
         const ctx = window.__KANNA_E2E__.setupState;
         const read = (value) => value && value.__v_isRef ? value.value : value;
         const db = ctx.db.value || ctx.db;
         db.select(
           "SELECT closed_at FROM pipeline_item WHERE id = ?",
           [${JSON.stringify(repoATaskId)}],
         ).then((rows) => cb({
           closedAt: rows[0]?.closed_at ?? null,
           selectedRepoId: read(ctx.store.selectedRepoId) ?? null,
           selectedItemId: read(ctx.store.selectedItemId) ?? null,
         })).catch((error) => cb({ __error: error?.message || String(error) }));`,
      );
      expect(closeState).toEqual({
        closedAt: expect.any(String),
        selectedRepoId: repoAId,
        selectedItemId: null,
      });

      await assertEmptyRepoASelection(repoBTaskId);

      await client.executeSync("window.__KANNA_E2E__.ready = false; location.reload();");
      await client.waitForAppReady();
      await waitForCondition(async () => {
        const selectedRepoId = await getVueState(client, "selectedRepoId");
        const selectedItemId = await getVueState(client, "selectedItemId");
        return selectedRepoId === repoAId && selectedItemId === null;
      }, "persisted empty repository A selection after reload", 10_000, async () => ({
        selectedRepoId: await getVueState(client, "selectedRepoId"),
        selectedItemId: await getVueState(client, "selectedItemId"),
      }));

      await assertEmptyRepoASelection(repoBTaskId);

      delayedRepoATaskId = await createAgentTask(
        repoAId,
        testRepoPath,
        "Close response delayed in repository A",
      );
      await callVueMethod(client, "handleSelectItem", delayedRepoATaskId);
      await persistWindowSelection(client, { repoId: repoAId, itemId: delayedRepoATaskId });

      try {
        await client.executeSync(
          `const originalFetch = globalThis.fetch;
           const callOriginalFetch = originalFetch.bind(globalThis);
           let releaseCloseResponse;
           const closeResponseGate = new Promise((resolve) => { releaseCloseResponse = resolve; });
           const gate = {
             originalFetch,
             responseHeld: false,
             responseReleased: false,
             closeStatus: "pending",
             closeError: null,
             closePromise: null,
             release() {
               if (this.responseReleased) return;
               this.responseReleased = true;
               releaseCloseResponse();
             },
           };
           window.__KANNA_TASK_CLOSE_GATE__ = gate;
           globalThis.fetch = async (input, init) => {
             const url = typeof input === "string"
               ? input
               : input instanceof URL
                 ? input.href
                 : input.url;
             const method = String(
               init?.method ?? (input instanceof Request ? input.method : "GET")
             ).toUpperCase();
             const path = new URL(url, window.location.href).pathname;
             const response = await callOriginalFetch(input, init);
             if (
               method === "POST"
               && path === ${JSON.stringify(`/v1/tasks/${encodeURIComponent(delayedRepoATaskId)}/actions/close`)}
             ) {
               gate.responseHeld = true;
               await closeResponseGate;
             }
             return response;
           };
           return true;`,
        );

        await client.executeSync(
          `const gate = window.__KANNA_TASK_CLOSE_GATE__;
           const ctx = window.__KANNA_E2E__.setupState;
           gate.closePromise = Promise.resolve(ctx.closeSelectedWorkspaceTask())
             .then(() => { gate.closeStatus = "fulfilled"; })
             .catch((error) => {
               gate.closeStatus = "rejected";
               gate.closeError = error?.message || String(error);
             });
           return true;`,
        );

        await waitForCondition(
          async () => client.executeSync<boolean>(
            `return window.__KANNA_TASK_CLOSE_GATE__?.responseHeld === true;`,
          ),
          "server close response to be held after task close",
          15_000,
        );

        createdDuringCloseTaskId = await createAgentTask(
          repoBId,
          secondaryFixtureRepoRoot,
          "Created while repository A close response is pending",
        );
        await waitForCondition(async () => {
          const selectedRepoId = await getVueState(client, "selectedRepoId");
          const selectedTaskId = await getVueState(client, "selectedTaskId");
          return selectedRepoId === repoBId && selectedTaskId === createdDuringCloseTaskId;
        }, "new repository B task auto-selection while close response is pending", 10_000);

        await client.executeSync(
          `window.__KANNA_TASK_CLOSE_GATE__.release(); return true;`,
        );
        await waitForCondition(
          async () => client.executeSync<boolean>(
            `return window.__KANNA_TASK_CLOSE_GATE__?.closeStatus !== "pending";`,
          ),
          "delayed close completion",
          15_000,
        );

        const selectionAfterClose = await client.executeSync<{
          closeStatus: string;
          closeError: string | null;
          selectedRepoId: string | null;
          selectedTaskId: string | null;
        }>(
          `const ctx = window.__KANNA_E2E__.setupState;
           const read = (value) => value && value.__v_isRef ? value.value : value;
           const gate = window.__KANNA_TASK_CLOSE_GATE__;
           return {
             closeStatus: gate.closeStatus,
             closeError: gate.closeError,
             selectedRepoId: read(ctx.store.selectedRepoId) ?? null,
             selectedTaskId: read(ctx.store.selectedTaskId) ?? null,
           };`,
        );
        expect(selectionAfterClose).toEqual({
          closeStatus: "fulfilled",
          closeError: null,
          selectedRepoId: repoBId,
          selectedTaskId: createdDuringCloseTaskId,
        });

        await client.executeSync("window.__KANNA_E2E__.ready = false; location.reload();");
        await client.waitForAppReady();
        await waitForCondition(async () => {
          const selectedRepoId = await getVueState(client, "selectedRepoId");
          const selectedTaskId = await getVueState(client, "selectedTaskId");
          return selectedRepoId === repoBId && selectedTaskId === createdDuringCloseTaskId;
        }, "persisted newly created repository B task selection after delayed close and reload", 10_000);
      } finally {
        await client.executeSync(
          `const gate = window.__KANNA_TASK_CLOSE_GATE__;
           if (gate) {
             gate.release?.();
             globalThis.fetch = gate.originalFetch;
           }
           return true;`,
        ).catch(() => undefined);
        await client.executeAsync<string>(
          `const cb = arguments[arguments.length - 1];
           Promise.resolve(window.__KANNA_TASK_CLOSE_GATE__?.closePromise)
             .catch(() => undefined)
             .then(() => cb("settled"));`,
        ).catch(() => undefined);
        await client.executeSync(
          `delete window.__KANNA_TASK_CLOSE_GATE__; return true;`,
        ).catch(() => undefined);
      }
    } finally {
      for (const taskId of [
        repoATaskId,
        repoBTaskId,
        delayedRepoATaskId,
        createdDuringCloseTaskId,
      ]) {
        if (!taskId) continue;
        await callVueMethod(client, "store.closeTask", taskId, { selectNext: false })
          .catch(() => undefined);
      }
    }
  });
});
