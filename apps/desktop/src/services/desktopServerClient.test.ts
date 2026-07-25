import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeDesktopTask,
  createDesktopBackup,
  fetchDesktopRepoAgentDefinition,
  fetchDesktopRepoAgentProviders,
  fetchDesktopRepoKannaDefinitions,
  fetchDesktopRepoPipelineDefinition,
  fetchDesktopRepoCommands,
  runDesktopRepoCommand,
  fetchDesktopSnapshot,
  fetchPendingIncomingTransfers,
  getDesktopSetting,
  mutateDesktopWindowWorkspace,
  setDesktopTaskCloudIdentity,
  setDesktopServerClientHandlersForTests,
  setDesktopSnapshotFetcherForTests,
} from "./desktopServerClient";

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
        headers: undefined,
        body: undefined,
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
        headers: undefined,
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
      { method: "GET", headers: undefined, body: undefined }
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:48121/v1/repos/repo%2Fone/commands/custom%3Aship%2Frelease/run",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ catalogRevision: "catalog-v1" })
      }
    );
  });

  it("fetches the repo Kanna definition manifest from the encoded repo endpoint", async () => {
    const response = {
      revision: "abc123",
      refName: "origin/main",
      config: {
        pipeline: "qa",
        reserved_port_offsets: [0, 2],
        stage_order: ["review", "pr"],
      },
      defaultPipeline: "qa",
      pipelines: ["default", "qa"],
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
        headers: undefined,
        body: undefined,
      },
    );
  });

  it("fetches a revisioned pipeline definition with each path segment encoded independently", async () => {
    const response = {
      revision: "def456",
      definition: {
        name: "qa candidate",
        description: "Quality assurance pipeline",
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
      fetchDesktopRepoPipelineDefinition("repo/one", "qa candidate"),
    ).resolves.toEqual(response);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:48121/v1/repos/repo%2Fone/kanna-definitions/pipelines/qa%20candidate",
      {
        method: "GET",
        headers: undefined,
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
        headers: undefined,
        body: undefined,
      },
    );
  });

  it("allows tests to override repo definition clients", async () => {
    const manifest = {
      revision: "abc123",
      refName: "origin/main",
      config: {},
      defaultPipeline: "default",
      pipelines: ["default"],
    };
    const pipeline = {
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
    const fetchRepoPipelineDefinition = vi.fn(async () => pipeline);
    const fetchRepoAgentDefinition = vi.fn(async () => agent);
    const fetchMock = vi.fn(() => {
      throw new Error("unexpected fetch");
    });
    vi.stubGlobal("fetch", fetchMock);
    setDesktopServerClientHandlersForTests({
      fetchRepoKannaDefinitions,
      fetchRepoPipelineDefinition,
      fetchRepoAgentDefinition,
    });

    await expect(fetchDesktopRepoKannaDefinitions("repo-1")).resolves.toBe(manifest);
    await expect(fetchDesktopRepoPipelineDefinition("repo-1", "default")).resolves.toBe(pipeline);
    await expect(fetchDesktopRepoAgentDefinition("repo-1", "implement")).resolves.toBe(agent);
    expect(fetchRepoKannaDefinitions).toHaveBeenCalledWith("repo-1");
    expect(fetchRepoPipelineDefinition).toHaveBeenCalledWith("repo-1", "default");
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
        headers: undefined,
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
        headers: undefined,
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
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cloudTaskId: "task-source-stable" }),
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
        headers: { "content-type": "application/json" },
        body: JSON.stringify(mutation),
      },
    );
  });

  it("normalizes pending incoming transfers returned by the server", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          transfers: [
            {
              id: "transfer-1",
              status: "pending",
              sourcePeerId: "peer-source",
              sourceTaskId: "task-source",
              localTaskId: null,
              payloadJson: "{\"task\":{},\"repo\":{}}",
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPendingIncomingTransfers()).resolves.toEqual([
      {
        id: "transfer-1",
        status: "pending",
        source_peer_id: "peer-source",
        source_task_id: "task-source",
        local_task_id: null,
        payload_json: "{\"task\":{},\"repo\":{}}",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:48121/v1/transfers/incoming/pending",
      {
        method: "GET",
        headers: undefined,
        body: undefined,
      },
    );
  });
});
