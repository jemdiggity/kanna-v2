import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeDesktopTask,
  createDesktopTask,
  createDesktopBackup,
  fetchDesktopRepoAgentDefinition,
  fetchDesktopRepoAgentProviders,
  fetchDesktopRepoKannaDefinitions,
  fetchDesktopRepoWorkflowDefinition,
  fetchDesktopRepoCommands,
  runDesktopRepoCommand,
  fetchDesktopSnapshot,
  fetchDesktopTaskDetail,
  getDesktopSetting,
  addDesktopRepo,
  mutateDesktopWindowWorkspace,
  putDesktopCloudTransferIdentity,
  setDesktopTaskCloudIdentity,
  setDesktopTaskWorkflow,
  approveIncomingTaskTransfer,
  pushTaskToPeer,
  rejectIncomingTaskTransfer,
  setDesktopServerClientHandlersForTests,
  setDesktopSnapshotFetcherForTests,
} from "./desktopServerClient";

/**
 * The webview is a browser, so `kanna-server` refuses its requests unless they
 * carry this desktop's local control credential; the Tauri mock hands out this
 * one. See `services/localControlCredential.ts`.
 */
const LOCAL_CREDENTIAL_HEADERS = { Authorization: "Bearer mock-local-control-credential" };
const JSON_REQUEST_HEADERS = { ...LOCAL_CREDENTIAL_HEADERS, "content-type": "application/json" };

const mocks = vi.hoisted(() => {
  const invoke = vi.fn(async (command: string, args?: { name?: string }) => {
    if (command === "ensure_mobile_server") return undefined;
    if (command === "mobile_server_status") return { state: "running", lanPort: 48121 };
    if (command === "read_env_var" && args?.name === "KANNA_MOBILE_SERVER_PORT") {
      throw new Error("env var not set");
    }
    throw new Error(`unexpected invoke: ${command}`);
  });
  return { invoke };
});

vi.mock("../invoke", () => ({
  invoke: mocks.invoke,
}));

describe("desktopServerClient", () => {
  beforeEach(() => {
    setDesktopServerClientHandlersForTests(null);
    setDesktopSnapshotFetcherForTests(null);
    mocks.invoke.mockClear();
  });

  afterEach(() => {
    setDesktopServerClientHandlersForTests(null);
    setDesktopSnapshotFetcherForTests(null);
    vi.unstubAllGlobals();
  });

  it("ensures the desktop server is running and uses its current port when fetching the snapshot", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          entries: [],
          taskBlockers: [],
          worktreePaths: {},
          settings: {},
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchDesktopSnapshot()).resolves.toEqual({
      entries: [],
      taskBlockers: [],
      worktreePaths: {},
      settings: {},
    });

    expect(mocks.invoke).toHaveBeenCalledWith("mobile_server_status");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:48121/v1/snapshot",
      {
        method: "GET",
        headers: LOCAL_CREDENTIAL_HEADERS,
        body: undefined,
      },
    );
  });

  it("fetches current task detail from the encoded task endpoint", async () => {
    const detail = {
      id: "task/parked",
      stage: "review",
      closedAt: null,
      latestRun: {
        stage: "review",
        kind: "main",
        status: "failed",
        summary: "Parked for human review: budget spent.",
        resumedFromRunId: null,
        resumeFallbackReason: null,
        finishedAt: "2026-08-03T00:00:00Z",
      },
      revisionRounds: 3,
      revisionLimit: 3,
      childTaskIds: ["closed-specialty-child"],
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(detail), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchDesktopTaskDetail("task/parked")).resolves.toEqual(detail);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:48121/v1/tasks/task%2Fparked",
      { method: "GET", headers: LOCAL_CREDENTIAL_HEADERS, body: undefined },
    );
  });

  it("uses PUT only for requested task IDs and preserves POST for ordinary creation", async () => {
    const response = {
      taskId: "task-created",
      repoId: "repo-1",
      title: "Ship it",
      stage: "in progress",
      agentType: "pty",
      worktreePath: "/tmp/task-created",
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const ordinaryRequest = { repoId: "repo-1", prompt: "Ship it" };
    await createDesktopTask(ordinaryRequest);
    await createDesktopTask({
      ...ordinaryRequest,
      requestedTaskId: "0123456789abcdef".repeat(4),
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:48121/v1/tasks",
      {
        method: "POST",
        headers: JSON_REQUEST_HEADERS,
        body: JSON.stringify(ordinaryRequest),
      },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `http://127.0.0.1:48121/v1/tasks/${"0123456789abcdef".repeat(4)}`,
      {
        method: "PUT",
        headers: JSON_REQUEST_HEADERS,
        body: JSON.stringify(ordinaryRequest),
      },
    );
  });

  /**
   * `PUT /v1/tasks/{id}` answers 409 while a creation for that id is already in
   * flight, and `createDesktopTask` carries a 15s retry budget precisely to wait
   * that out — the concurrent creation finishes and the route then returns the
   * existing task. Treating 409 as terminal in the shared request path (as the
   * duplicate-transfer work briefly did) turns that transient conflict into an
   * immediate throw and loses the task.
   */
  it("retries a requested task creation that is already in flight instead of failing on its 409", async () => {
    const response = {
      taskId: "task-requested",
      repoId: "repo-1",
      title: "Ship it",
      stage: "in progress",
      agentType: "pty",
      worktreePath: "/tmp/task-requested",
    };
    let attempts = 0;
    const fetchMock = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response("task creation already in progress: task-requested", { status: 409 });
      }
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(createDesktopTask({
      repoId: "repo-1",
      prompt: "Ship it",
      requestedTaskId: "0123456789abcdef".repeat(4),
    })).resolves.toEqual(response);
    expect(attempts).toBe(2);
  });

  /**
   * The counterpart: a caller that wants a conflict answered rather than waited
   * out asks for no retry budget. A transfer intent is one of those — the
   * engine's own eligibility read is what resolves a duplicate, so waiting out
   * a conflict here would only delay the answer.
   */
  it("surfaces a conflict immediately for a request with no retry budget", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: "task not found" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(pushTaskToPeer("task-source", "peer-target")).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /**
   * A transfer is server work now, so the renderer states an intent and reads
   * whether it was newly scheduled. `false` is a retried request, not a second
   * transfer.
   */
  it("states a push intent and reports whether it was newly scheduled", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ scheduled: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(pushTaskToPeer("task source/1", "peer-target", {
      transport: "lan",
      cloudFallback: true,
      targetDesktopId: "desktop-target",
      intentKey: "intent-1",
    })).resolves.toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/v1/tasks/task%20source%2F1/actions/push-to-peer");
    expect(JSON.parse(String(init.body))).toEqual({
      peerId: "peer-target",
      transport: "lan",
      cloudFallback: true,
      targetDesktopId: "desktop-target",
      intentKey: "intent-1",
    });
  });

  it("states approve and reject intents for an incoming transfer", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ scheduled: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(approveIncomingTaskTransfer("transfer-1")).resolves.toBe(false);
    await expect(rejectIncomingTaskTransfer("transfer-1")).resolves.toBe(false);
    expect(fetchMock.mock.calls.map(([url]) => String(url).split("/v1")[1])).toEqual([
      "/transfers/transfer-1/actions/approve",
      "/transfers/transfer-1/actions/reject-incoming",
    ]);
  });

  it("passes the requested default branch when registering a transferred repo", async () => {
    const response = {
      id: "repo-1",
      path: "/tmp/transferred-repo",
      name: "Transferred Repo",
      defaultBranch: "trunk",
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(addDesktopRepo({
      path: "/tmp/transferred-repo",
      name: "Transferred Repo",
      defaultBranch: "trunk",
    })).resolves.toEqual(response);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:48121/v1/repos",
      {
        method: "POST",
        headers: JSON_REQUEST_HEADERS,
        body: JSON.stringify({
          path: "/tmp/transferred-repo",
          name: "Transferred Repo",
          defaultBranch: "trunk",
        }),
      },
    );
  });

  it("fetches repo-scoped agent providers from the encoded repo endpoint", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          providers: [
            { id: "claude", executable: "/repo/.kanna/bin/claude" },
            { id: "future-provider", executable: "/repo/.kanna/bin/future-provider" },
            { id: "opencode", executable: "/repo/.kanna/bin/opencode" },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchDesktopRepoAgentProviders("repo/with space")).resolves.toEqual([
      "claude",
      "opencode",
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:48121/v1/repos/repo%2Fwith%20space/agent-providers",
      {
        method: "GET",
        headers: LOCAL_CREDENTIAL_HEADERS,
        body: undefined,
      },
    );
  });

  it("lists and runs encoded repository commands", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        repoId: "repo/one",
        revision: "catalog-v1",
        commands: []
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        taskId: "command-task",
        reused: false
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchDesktopRepoCommands("repo/one")).resolves.toMatchObject({
      revision: "catalog-v1"
    });
    await expect(
      runDesktopRepoCommand("repo/one", "custom:ship/release", "catalog-v1")
    ).resolves.toEqual({ taskId: "command-task", reused: false });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:48121/v1/repos/repo%2Fone/commands",
      { method: "GET", headers: LOCAL_CREDENTIAL_HEADERS, body: undefined }
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:48121/v1/repos/repo%2Fone/commands/custom%3Aship%2Frelease/run",
      {
        method: "POST",
        headers: JSON_REQUEST_HEADERS,
        body: JSON.stringify({ catalogRevision: "catalog-v1" })
      }
    );
  });

  it("fetches the repo Kanna definition manifest from the encoded repo endpoint", async () => {
    const response = {
      revision: "abc123",
      refName: "origin/main",
      config: {
        workflow: "qa",
        reserved_port_offsets: [0, 2],
        stage_order: ["review", "pr"],
      },
      defaultWorkflow: "qa",
      workflows: ["default", "qa"],
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchDesktopRepoKannaDefinitions("repo/with space")).resolves.toEqual(response);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:48121/v1/repos/repo%2Fwith%20space/kanna-definitions",
      {
        method: "GET",
        headers: LOCAL_CREDENTIAL_HEADERS,
        body: undefined,
      },
    );
  });

  it("fetches a revisioned workflow definition with each path segment encoded independently", async () => {
    const response = {
      revision: "def456",
      definition: {
        name: "qa candidate",
        description: "Quality assurance workflow",
        environments: {
          test: {
            setup: ["pnpm install"],
            teardown: ["pnpm clean"],
          },
        },
        stages: [{
          name: "in progress",
          agent: "implement",
          agent_provider: ["codex", "claude"],
          environment: "test",
          policy: { transition: "manual" },
          post: {
            name: "commit",
            agent: "commit",
            agent_provider: ["codex"],
          },
        }],
      },
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchDesktopRepoWorkflowDefinition("repo/one", "qa candidate"),
    ).resolves.toEqual(response);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:48121/v1/repos/repo%2Fone/kanna-definitions/workflows/qa%20candidate",
      {
        method: "GET",
        headers: LOCAL_CREDENTIAL_HEADERS,
        body: undefined,
      },
    );
  });

  it("fetches a revisioned agent definition with each path segment encoded independently", async () => {
    const response = {
      revision: null,
      definition: {
        name: "Reviewer",
        description: "Reviews task changes",
        prompt: "Review the implementation.",
        agent_provider: ["codex", "claude"],
        model: "gpt-5",
        permission_mode: "dontAsk",
        allowed_tools: ["Read", "Bash"],
      },
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchDesktopRepoAgentDefinition("repo/one", "review@strict"),
    ).resolves.toEqual(response);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:48121/v1/repos/repo%2Fone/kanna-definitions/agents/review%40strict",
      {
        method: "GET",
        headers: LOCAL_CREDENTIAL_HEADERS,
        body: undefined,
      },
    );
  });

  it("allows tests to override repo definition clients", async () => {
    const manifest = {
      revision: "abc123",
      refName: "origin/main",
      config: {},
      defaultWorkflow: "default",
      workflows: ["default"],
    };
    const workflow = {
      revision: "abc123",
      definition: {
        name: "default",
        stages: [{ name: "in progress", policy: { transition: "manual" as const } }],
      },
    };
    const agent = {
      revision: "abc123",
      definition: {
        name: "Implementer",
        description: "Implements tasks",
        prompt: "Implement the task.",
      },
    };
    const fetchRepoKannaDefinitions = vi.fn(async () => manifest);
    const fetchRepoWorkflowDefinition = vi.fn(async () => workflow);
    const fetchRepoAgentDefinition = vi.fn(async () => agent);
    const fetchMock = vi.fn(() => {
      throw new Error("unexpected fetch");
    });
    vi.stubGlobal("fetch", fetchMock);
    setDesktopServerClientHandlersForTests({
      fetchRepoKannaDefinitions,
      fetchRepoWorkflowDefinition,
      fetchRepoAgentDefinition,
    });

    await expect(fetchDesktopRepoKannaDefinitions("repo-1")).resolves.toBe(manifest);
    await expect(fetchDesktopRepoWorkflowDefinition("repo-1", "default")).resolves.toBe(workflow);
    await expect(fetchDesktopRepoAgentDefinition("repo-1", "implement")).resolves.toBe(agent);
    expect(fetchRepoKannaDefinitions).toHaveBeenCalledWith("repo-1");
    expect(fetchRepoWorkflowDefinition).toHaveBeenCalledWith("repo-1", "default");
    expect(fetchRepoAgentDefinition).toHaveBeenCalledWith("repo-1", "implement");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows tests to override server readiness checks", async () => {
    const ensureMobileServer = vi.fn(async () => {});
    setDesktopServerClientHandlersForTests({ ensureMobileServer });
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          entries: [],
          taskBlockers: [],
          worktreePaths: {},
          settings: {},
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchDesktopSnapshot();

    expect(ensureMobileServer).toHaveBeenCalled();
    expect(ensureMobileServer.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0]);
  });

  it("creates backups through the desktop server endpoint", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          backupPath: "/mock/data/kanna-v2.db.backup-2026-07-07T00-00-00",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(createDesktopBackup()).resolves.toEqual({
      backupPath: "/mock/data/kanna-v2.db.backup-2026-07-07T00-00-00",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:48121/v1/backup",
      {
        method: "POST",
        headers: LOCAL_CREDENTIAL_HEADERS,
        body: undefined,
      },
    );
  });

  it("treats a 204 close-task response as success", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(closeDesktopTask("task-1")).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:48121/v1/tasks/task-1/actions/close",
      {
        method: "POST",
        headers: LOCAL_CREDENTIAL_HEADERS,
        body: undefined,
      },
    );
  });

  it("sets a task cloud identity through the encoded task endpoint", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ cloudTaskId: "task-source-stable" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      setDesktopTaskCloudIdentity("task/with space", "task-source-stable"),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:48121/v1/tasks/task%2Fwith%20space/actions/cloud-task-identity",
      {
        method: "PUT",
        headers: JSON_REQUEST_HEADERS,
        body: JSON.stringify({ cloudTaskId: "task-source-stable" }),
      },
    );
  });

  it("changes a task workflow through the encoded local task endpoint", async () => {
    const response = {
      taskId: "task/with space",
      workflowName: "single-reviewer",
      stage: "in progress",
      revisionRounds: 2,
      revisionLimit: 3,
    };
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      setDesktopTaskWorkflow("task/with space", "single-reviewer"),
    ).resolves.toEqual(response);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:48121/v1/tasks/task%2Fwith%20space/actions/set-workflow",
      {
        method: "POST",
        headers: JSON_REQUEST_HEADERS,
        body: JSON.stringify({ workflowName: "single-reviewer" }),
      },
    );
  });

  it("stores the local transfer identity through the dedicated loopback endpoint", async () => {
    const identity = {
      peerId: "peer-a",
      displayName: "Studio Mac",
      publicKey: "base64-key",
      protocolVersion: 1,
      acceptingTransfers: true,
    };
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ key: "cloud_transfer_identity_v1", value: identity }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(putDesktopCloudTransferIdentity(identity)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:48121/v1/settings/cloud-transfer-identity",
      {
        method: "PUT",
        headers: JSON_REQUEST_HEADERS,
        body: JSON.stringify(identity),
      },
    );
  });

  it("allows tests to override task cloud identity writes", async () => {
    const setTaskCloudIdentity = vi.fn(async () => {});
    const fetchMock = vi.fn(() => {
      throw new Error("unexpected fetch");
    });
    vi.stubGlobal("fetch", fetchMock);
    setDesktopServerClientHandlersForTests({ setTaskCloudIdentity });

    await expect(
      setDesktopTaskCloudIdentity("task-1", "task-source-stable"),
    ).resolves.toBeUndefined();

    expect(setTaskCloudIdentity).toHaveBeenCalledWith("task-1", "task-source-stable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries transient setting read failures during startup", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("Load failed"))
      .mockResolvedValueOnce(new Response("setting not found", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getDesktopSetting("window_workspace_v1")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "mobile_server_status")).toHaveLength(2);
  });

  it("sends narrow window workspace mutations to the atomic server endpoint", async () => {
    const response = {
      windows: [{
        windowId: "window-2",
        selectedRepoId: "repo-new",
        selectedItemId: "task-new",
        sidebarHidden: false,
        sidebarWidth: 260,
        order: 0,
      }],
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const mutation = {
      operation: "updateSelection" as const,
      windowId: "window-2",
      selectedRepoId: "repo-new",
      selectedItemId: "task-new",
    };

    await expect(mutateDesktopWindowWorkspace(mutation)).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:48121/v1/window-workspace/mutations",
      {
        method: "POST",
        headers: JSON_REQUEST_HEADERS,
        body: JSON.stringify(mutation),
      },
    );
  });

});
