import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { DbHandle, PipelineItem, Repo } from "../types/kanna";
import {
  buildOutgoingTransferPayload,
  chooseRepoAcquisitionMode,
  parseIncomingTransferRequest,
  parsePairingResult,
  parseTransferPeers,
  parseOutgoingTransferPreflightResult,
} from "../utils/taskTransfer";
import type { SessionRecoveryState } from "../composables/sessionRecoveryState";
import {
  setDesktopSnapshotFetcherForTests,
  setDesktopServerClientHandlersForTests,
  type NewTaskTransferInput,
  type NewTaskTransferProvenanceInput,
} from "../services/desktopServerClient";

const invokeMock = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>();
const loadSessionRecoveryStateMock = vi.fn<(sessionId: string) => Promise<SessionRecoveryState | null>>();

vi.mock("../invoke", () => ({
  invoke: invokeMock,
}));

vi.mock("../composables/sessionRecoveryState", () => ({
  loadSessionRecoveryState: loadSessionRecoveryStateMock,
}));

vi.mock("../tauri-mock", () => ({
  isTauri: false,
}));

vi.mock("../listen", () => ({
  listen: vi.fn(async () => () => undefined),
}));

vi.mock("../composables/useToast", () => ({
  useToast: () => ({
    toasts: { value: [] },
    dismiss: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }),
}));

function buildRepo(): Repo {
  return {
    id: "repo-1",
    path: "/tmp/repo-1",
    name: "repo-1",
    default_branch: "main",
    hidden: 0,
    sort_order: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    last_opened_at: "2026-01-01T00:00:00.000Z",
  };
}

function buildItem(repoId = "repo-1"): PipelineItem {
  return {
    id: "task-source",
    repo_id: repoId,
    issue_number: null,
    issue_title: null,
    prompt: "Fix handoff",
    pipeline: "default",
    stage: "in progress",
    stage_result: null,
    tags: "[]",
    pr_number: null,
    pr_url: null,
    branch: "task-task-source",
    closed_at: null,
    agent_type: "pty",
    agent_provider: "claude",
    activity: "idle",
    activity_changed_at: null,
    unread_at: null,
    port_offset: null,
    display_name: null,
    port_env: null,
    pinned: 0,
    pin_order: null,
    base_ref: "main",
    agent_session_id: null,
    previous_stage: null,
    teardown_started_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function buildIncomingTransferPayload() {
  return {
    target_peer_id: "peer-target",
    task: {
      source_peer_id: "peer-source",
      source_task_id: "task-source",
      resume_session_id: null,
      prompt: "Fix handoff",
      stage: "in progress",
      branch: "task-source",
      pipeline: "default",
      display_name: "Transferred task",
      base_ref: "main",
      agent_type: "agent",
      agent_provider: "claude" as const,
    },
    repo: {
      mode: "reuse-local" as const,
      remote_url: "git@github.com:jemdiggity/kanna.git",
      path: "/tmp/repo-1",
      name: "repo-1",
      default_branch: "main",
      bundle: null,
    },
    recovery: null,
  };
}

function mockIncomingTransferApprovalInvoke(
  finalizedPayload: ReturnType<typeof buildIncomingTransferPayload>,
  handler: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
) {
  invokeMock.mockImplementation(async (cmd, args) => {
    if (cmd === "finalize_outgoing_transfer") {
      return {
        transferId: "transfer-1",
        payload: finalizedPayload,
        finalizedCleanly: true,
      };
    }
    if (cmd === "git_default_branch") {
      return "main";
    }
    if (cmd === "git_list_base_branches") {
      return ["origin/main", "main", finalizedPayload.task.branch].filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      );
    }
    if (cmd === "git_fetch") {
      return null;
    }
    return handler(cmd, args);
  });
}

async function flushBackgroundSetup(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

function createTransferDb(initial: {
  repos?: Repo[];
  items?: PipelineItem[];
  transfers?: Array<Record<string, unknown>>;
}) {
  const tables = {
    repo: [...(initial.repos ?? [])],
    pipeline_item: [...(initial.items ?? [])],
    task_transfer: [...(initial.transfers ?? [])],
    task_transfer_provenance: [] as Array<Record<string, unknown>>,
  };

  setDesktopSnapshotFetcherForTests(async () => ({
    entries: tables.repo.map((repo) => ({
      repo,
      items: tables.pipeline_item.filter((item) => item.repo_id === repo.id && item.closed_at === null),
    })),
    taskBlockers: [],
    worktreePaths: {},
    settings: {},
  }));

  setDesktopServerClientHandlersForTests({
    getSetting: async () => null,
    deleteSetting: async () => {},
    putSetting: async (key, value) => ({ key, value }),
    postOperatorEvents: async () => {},
    applyTaskRuntimeStatus: async (taskId, input) => {
      const item = tables.pipeline_item.find((candidate) => candidate.id === taskId);
      if (!item || item.closed_at != null) return { taskId, activity: null };
      let activity: PipelineItem["activity"] | null = null;
      if (input.status === "busy" && item.activity !== "working") {
        activity = "working";
      } else if ((input.status === "idle" || input.status === "waiting") && item.activity === "working") {
        activity = input.selected ? "idle" : "unread";
      }
      if (activity) item.activity = activity;
      return { taskId, activity };
    },
    markTaskRead: async (taskId) => {
      const item = tables.pipeline_item.find((candidate) => candidate.id === taskId);
      if (item?.activity === "unread") item.activity = "idle";
      return { taskId, activity: item?.activity === "idle" ? "idle" : null };
    },
    claimTaskPorts: async (taskId) => ({ taskId, portEnv: {}, firstPort: null }),
    releaseTaskPorts: async () => {},
    closeTask: async (taskId) => {
      const item = tables.pipeline_item.find((candidate) => candidate.id === taskId);
      if (item) {
        item.closed_at = new Date().toISOString();
        item.updated_at = item.closed_at;
      }
    },
    findRepoByPath: async (path: string) =>
      tables.repo.find((repo) => repo.path === path) as never ?? null,
    addRepo: async ({ path, name }) => {
      const existing = tables.repo.find((repo) => repo.path === path);
      if (existing) return existing as never;
      const repo = {
        ...buildRepo(),
        id: `repo-${tables.repo.length + 1}`,
        path,
        name: name ?? path.split("/").pop() ?? "repo",
      };
      tables.repo.push(repo);
      return repo as never;
    },
    patchRepo: async (repoId, input) => {
      const repo = tables.repo.find((candidate) => candidate.id === repoId);
      if (!repo) return;
      if (input.name !== undefined) repo.name = input.name;
      if (input.remoteUrl !== undefined) repo.remote_url = input.remoteUrl;
      if (input.remoteUrlHash !== undefined) repo.remote_url_hash = input.remoteUrlHash;
      if (input.hidden !== undefined) repo.hidden = input.hidden ? 1 : 0;
    },
    insertTaskTransfer: async (transfer: NewTaskTransferInput) => {
      if (tables.task_transfer.some((row) => row.id === transfer.id)) {
        throw new Error("UNIQUE constraint failed: task_transfer.id");
      }
      tables.task_transfer.push({
        ...transfer,
        started_at: new Date().toISOString(),
        completed_at: null,
      });
    },
    getTaskTransfer: async (transferId: string) =>
      tables.task_transfer.find((transfer) => transfer.id === transferId) as never ?? null,
    updateTaskTransferPayload: async (transferId: string, payloadJson: string) => {
      const row = tables.task_transfer.find((transfer) => transfer.id === transferId);
      if (!row) return false;
      row.payload_json = payloadJson;
      row.error = null;
      return true;
    },
    completeTaskTransfer: async (transferId: string, localTaskId: string) => {
      const row = tables.task_transfer.find((transfer) => transfer.id === transferId);
      if (!row) return false;
      row.status = "completed";
      row.local_task_id = localTaskId;
      row.completed_at = new Date().toISOString();
      row.error = null;
      return true;
    },
    rejectTaskTransfer: async (transferId: string, reason: string) => {
      const row = tables.task_transfer.find((transfer) => transfer.id === transferId);
      if (!row) return false;
      row.status = "rejected";
      row.completed_at = new Date().toISOString();
      row.error = reason;
      return true;
    },
    insertTaskTransferProvenance: async (provenance: NewTaskTransferProvenanceInput) => {
      tables.task_transfer_provenance.push(provenance);
    },
  });

  const db = {
    tables,
    execute: vi.fn(async (sql: string, params?: unknown[]) => {
      const q = sql.trim().toUpperCase();

      if (q.startsWith("INSERT INTO REPO")) {
        const [id, path, name, defaultBranch] = params as [string, string, string, string];
        tables.repo.push({
          id,
          path,
          name,
          default_branch: defaultBranch,
          hidden: 0,
          sort_order: tables.repo.length,
          created_at: new Date().toISOString(),
          last_opened_at: new Date().toISOString(),
        });
        return { rowsAffected: 1 };
      }

      if (q.startsWith("INSERT INTO PIPELINE_ITEM")) {
        const [
          id,
          repoId,
          issueNumber,
          issueTitle,
          prompt,
          pipeline,
          stage,
          prNumber,
          prUrl,
          branch,
          agentType,
          agentProvider,
          portOffset,
          portEnv,
          agentSpawnOptions,
          activity,
          displayName,
          baseRef,
          parentTaskId,
          pipelineDef,
        ] = params as unknown[];
        tables.pipeline_item.push({
          id: id as string,
          repo_id: repoId as string,
          issue_number: issueNumber as number | null,
          issue_title: issueTitle as string | null,
          prompt: prompt as string | null,
          pipeline: pipeline as string,
          pipeline_def: pipelineDef as string | null,
          stage: stage as string,
          pr_number: prNumber as number | null,
          pr_url: prUrl as string | null,
          branch: branch as string | null,
          closed_at: null,
          agent_type: agentType as string | null,
          agent_provider: agentProvider as PipelineItem["agent_provider"],
          activity: activity as PipelineItem["activity"],
          activity_changed_at: new Date().toISOString(),
          unread_at: null,
          port_offset: portOffset as number | null,
          display_name: displayName as string | null,
          last_output_preview: null,
          port_env: portEnv as string | null,
          agent_spawn_options: agentSpawnOptions as string | null,
          pinned: 0,
          pin_order: null,
          base_ref: baseRef as string | null,
          agent_session_id: null,
          teardown_started_at: null,
          parent_task_id: parentTaskId as string | null,
          notify_task_id: null,
          notified_at: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        return { rowsAffected: 1 };
      }

      if (q.startsWith("UPDATE PIPELINE_ITEM SET PORT_OFFSET")) {
        const [portOffset, portEnv, id] = params as [number | null, string | null, string];
        const row = tables.pipeline_item.find((item) => item.id === id);
        if (row) {
          row.port_offset = portOffset;
          row.port_env = portEnv;
        }
        return { rowsAffected: row ? 1 : 0 };
      }

      if (q.startsWith("UPDATE PIPELINE_ITEM SET ACTIVITY")) {
        const [activity, id] = params as [PipelineItem["activity"], string];
        const row = tables.pipeline_item.find((item) => item.id === id);
        if (row) {
          row.activity = activity;
        }
        return { rowsAffected: row ? 1 : 0 };
      }

      if (q.startsWith("UPDATE PIPELINE_ITEM SET")) {
        const id = params?.[params.length - 1] as string | undefined;
        const row = tables.pipeline_item.find((item) => item.id === id);
        if (!row) {
          return { rowsAffected: 0 };
        }

      if (q.startsWith("UPDATE PIPELINE_ITEM SET STAGE = ?")) {
          const [stage] = params as [string, string];
          row.stage = stage;
        }

        if (q.includes("TEARDOWN_STARTED_AT")) {
          row.teardown_started_at = q.includes("TEARDOWN_STARTED_AT = NULL") ? null : new Date().toISOString();
        }

        if (q.startsWith("UPDATE PIPELINE_ITEM SET AGENT_SESSION_ID = ?")) {
          const [agentSessionId] = params as [string, string];
          row.agent_session_id = agentSessionId;
        }

        if (q.includes("CLOSED_AT = DATETIME('NOW')")) {
          row.teardown_started_at = null;
          row.closed_at = new Date().toISOString();
        }

        return { rowsAffected: 1 };
      }

      if (q.startsWith("INSERT INTO TASK_TRANSFER_PROVENANCE")) {
        const [pipelineItemId, sourcePeerId, sourceTaskId, sourceMachineTaskLabel] =
          params as [string, string, string, string | null];
        tables.task_transfer_provenance.push({
          pipeline_item_id: pipelineItemId,
          source_peer_id: sourcePeerId,
          source_task_id: sourceTaskId,
          source_machine_task_label: sourceMachineTaskLabel,
        });
        return { rowsAffected: 1 };
      }

      if (q.startsWith("UPDATE TASK_TRANSFER SET STATUS = 'COMPLETED'")) {
        const [localTaskId, transferId] = params as [string, string];
        const row = tables.task_transfer.find((transfer) => transfer.id === transferId);
        if (row) {
          row.status = "completed";
          row.local_task_id = localTaskId;
          row.completed_at = new Date().toISOString();
          row.error = null;
        }
        return { rowsAffected: row ? 1 : 0 };
      }

      if (q.startsWith("UPDATE TASK_TRANSFER SET STATUS = 'REJECTED'")) {
        const [error, transferId] = params as [string, string];
        const row = tables.task_transfer.find((transfer) => transfer.id === transferId);
        if (row) {
          row.status = "rejected";
          row.completed_at = new Date().toISOString();
          row.error = error;
        }
        return { rowsAffected: row ? 1 : 0 };
      }

      if (q.startsWith("INSERT INTO TASK_TRANSFER")) {
        const [
          id,
          direction,
          status,
          sourcePeerId,
          targetPeerId,
          sourceTaskId,
          localTaskId,
          error,
          payloadJson,
        ] = params as [
          string,
          string,
          string,
          string | null,
          string | null,
          string | null,
          string | null,
          string | null,
          string | null,
        ];
        tables.task_transfer.push({
          id,
          direction,
          status,
          source_peer_id: sourcePeerId,
          target_peer_id: targetPeerId,
          source_task_id: sourceTaskId,
          local_task_id: localTaskId,
          started_at: new Date().toISOString(),
          completed_at: null,
          error,
          payload_json: payloadJson,
        });
        return { rowsAffected: 1 };
      }

      return { rowsAffected: 0 };
    }),
    select: vi.fn(async (sql: string, params?: unknown[]) => {
      const q = sql.trim().toUpperCase();

      if (q.includes("FROM REPO WHERE PATH = ?")) {
        const [path] = params as [string];
        return tables.repo.filter((repo) => repo.path === path);
      }

      if (q.includes("FROM REPO")) {
        return tables.repo;
      }

      if (q.includes("FROM PIPELINE_ITEM")) {
        return tables.pipeline_item;
      }

      if (q.includes("FROM TASK_TRANSFER WHERE ID = ?")) {
        const [transferId] = params as [string];
        return tables.task_transfer.filter((transfer) => transfer.id === transferId);
      }

      if (q.includes("FROM TASK_TRANSFER_PROVENANCE")) {
        return tables.task_transfer_provenance;
      }

      if (q.includes("FROM TASK_PORT")) {
        return [];
      }

      if (q.includes("FROM SETTINGS")) {
        return [];
      }

      return [];
    }),
  } as unknown as DbHandle & typeof db;

  return db;
}

describe("chooseRepoAcquisitionMode", () => {
  it("returns reuse-local when the target already has the repository", () => {
    expect(
      chooseRepoAcquisitionMode({
        remoteUrl: "git@github.com:jemdiggity/kanna.git",
        targetHasRepo: true,
        bundle: null,
      }),
    ).toBe("reuse-local");
  });

  it("prefers clone-remote when a remote URL exists and target has no repo", () => {
    expect(
      chooseRepoAcquisitionMode({
        remoteUrl: "git@github.com:jemdiggity/kanna.git",
        targetHasRepo: false,
        bundle: null,
      }),
    ).toBe("clone-remote");
  });

  it("falls back to bundle-repo when no remote URL exists", () => {
    expect(
      chooseRepoAcquisitionMode({
        remoteUrl: null,
        targetHasRepo: false,
        bundle: {
          artifactId: "artifact-1",
          filename: "transfer-1.bundle",
          refName: "refs/heads/task-source",
        },
      }),
    ).toBe("bundle-repo");
  });
});

describe("parseTransferPeers", () => {
  it("preserves trust and accepting-transfer metadata for the peer picker", () => {
    expect(parseTransferPeers([
      {
        peer_id: "peer-secondary",
        display_name: "Secondary",
        trusted: true,
        accepting_transfers: false,
      },
    ])).toEqual([
      {
        id: "peer-secondary",
        name: "Secondary",
        trusted: true,
        acceptingTransfers: false,
        subtitle: "paired",
      },
    ]);
  });
});

describe("parsePairingResult", () => {
  it("requires a verification code in the pairing response", () => {
    expect(() =>
      parsePairingResult({
        peer: {
          peer_id: "peer-secondary",
          display_name: "Secondary",
          trusted: true,
          accepting_transfers: true,
        },
      }),
    ).toThrow("verification");
  });
});

describe("buildOutgoingTransferPayload", () => {
  it("preserves source provenance and does not allocate destination ids", () => {
    const payload = buildOutgoingTransferPayload({
      sourcePeerId: "peer-alpha",
      sourceTaskId: "task-source",
      targetPeerId: "peer-target",
      item: buildItem(),
      repoRemoteUrl: "git@github.com:jemdiggity/kanna.git",
      recovery: {
        serialized: "prompt> ",
        cols: 80,
        rows: 24,
        cursorRow: 0,
        cursorCol: 8,
        cursorVisible: true,
        savedAt: 0,
        sequence: 1,
      },
      targetHasRepo: false,
      bundle: null,
    });

    expect(payload.task.source_peer_id).toBe("peer-alpha");
    expect(payload.task.source_task_id).toBe("task-source");
    expect(payload.task.local_task_id).toBeUndefined();
    expect(payload.repo.mode).toBe("clone-remote");
    expect(payload.repo.bundle).toBeNull();
  });

  it("builds bundle-repo payloads with staged bundle metadata", () => {
    const payload = buildOutgoingTransferPayload({
      sourcePeerId: "peer-alpha",
      sourceTaskId: "task-source",
      targetPeerId: "peer-target",
      item: buildItem(),
      repoPath: "/tmp/repo-1",
      repoName: "repo-1",
      repoDefaultBranch: "main",
      repoRemoteUrl: null,
      recovery: null,
      targetHasRepo: false,
      bundle: {
        artifactId: "artifact-1",
        filename: "transfer-1.bundle",
        refName: "refs/heads/task-source",
      },
    });

    expect(payload.repo).toMatchObject({
      mode: "bundle-repo",
      remote_url: null,
      path: "/tmp/repo-1",
      name: "repo-1",
      default_branch: "main",
      bundle: {
        artifact_id: "artifact-1",
        filename: "transfer-1.bundle",
        ref_name: "refs/heads/task-source",
      },
    });
  });
});

describe("parseOutgoingTransferPreflightResult", () => {
  it("requires transferId in the preflight response", () => {
    expect(() =>
      parseOutgoingTransferPreflightResult({
        sourcePeerId: "peer-source",
        targetHasRepo: false,
      }),
    ).toThrow("transferId");
  });

  it("accepts the browser mock preflight payload", async () => {
    const { mockInvoke } = await vi.importActual<typeof import("../tauri-mock")>("../tauri-mock");

    expect(
      parseOutgoingTransferPreflightResult(
        mockInvoke("prepare_outgoing_transfer", {
          payload: {
            phase: "preflight",
          },
        }),
      ),
    ).toMatchObject({
      transferId: "mock-transfer-1",
      sourcePeerId: "mock-local-peer",
      targetHasRepo: false,
    });
  });
});

describe("parseIncomingTransferRequest", () => {
  it("requires the incoming transfer payload", () => {
    expect(() =>
      parseIncomingTransferRequest({
        type: "incoming_transfer_request",
        transfer_id: "transfer-1",
        source_peer_id: "peer-source",
        source_task_id: "task-source",
        source_name: "Primary",
      }),
    ).toThrow("payload");
  });
});

describe("pushTaskToPeer", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    loadSessionRecoveryStateMock.mockReset();
  });

  it("stays safe when transfer preflight fails", async () => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();

    store.repos = [buildRepo()];
    store.items = [buildItem()];

    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "prepare_outgoing_transfer") {
        throw new Error("kanna-task-transfer sidecar integration is not implemented yet");
      }
      return null;
    });

    await expect(store.pushTaskToPeer("task-source", "peer-target")).rejects.toThrow(
      "not implemented",
    );

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("prepare_outgoing_transfer", {
      payload: {
        phase: "preflight",
        sourceTaskId: "task-source",
        targetPeerId: "peer-target",
      },
    });
    expect(loadSessionRecoveryStateMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith("git_remote_url", expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith("kill_session", expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith("signal_session", expect.anything());
  });

  it("uses preflight sourcePeerId and targetHasRepo to build the final payload", async () => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const fakeDb = createTransferDb({});

    await store.init(fakeDb);
    store.repos = [buildRepo()];
    store.items = [buildItem()];

    loadSessionRecoveryStateMock.mockResolvedValue({
      serialized: "prompt> ",
      cols: 80,
      rows: 24,
      cursorRow: 0,
      cursorCol: 8,
      cursorVisible: true,
      savedAt: 123,
      sequence: 4,
    });

    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd === "prepare_outgoing_transfer") {
        const payload = args?.payload as Record<string, unknown> | undefined;
        if (payload?.phase === "preflight") {
          return {
            transferId: "transfer-123",
            sourcePeerId: "peer-real-source",
            targetHasRepo: true,
          };
        }
        return { ok: true };
      }
      if (cmd === "git_remote_url") {
        return "git@github.com:jemdiggity/kanna.git";
      }
      return null;
    });

    await expect(store.pushTaskToPeer("task-source", "peer-target")).resolves.toBeUndefined();

    const prepareCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "prepare_outgoing_transfer");
    expect(prepareCalls).toHaveLength(2);
    expect(prepareCalls[0]?.[1]).toEqual({
      payload: {
        phase: "preflight",
        sourceTaskId: "task-source",
        targetPeerId: "peer-target",
      },
    });
    expect(prepareCalls[1]?.[1]).toMatchObject({
      payload: {
        phase: "commit",
        transferId: "transfer-123",
        payload: {
          target_peer_id: "peer-target",
          task: {
            source_peer_id: "peer-real-source",
            source_task_id: "task-source",
            resume_session_id: null,
          },
          repo: {
            mode: "reuse-local",
          },
        },
      },
    });
    expect(invokeMock).not.toHaveBeenCalledWith("git_remote_url", expect.anything());
  });

  it("records an outgoing transfer row after commit starts", async () => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const fakeDb = createTransferDb({});

    await store.init(fakeDb);
    store.repos = [buildRepo()];
    store.items = [buildItem()];

    loadSessionRecoveryStateMock.mockResolvedValue(null);

    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "prepare_outgoing_transfer") {
        return {
          transferId: "transfer-123",
          sourcePeerId: "peer-real-source",
          targetHasRepo: false,
        };
      }
      return null;
    });

    await expect(store.pushTaskToPeer("task-source", "peer-target")).resolves.toBeUndefined();

    expect(fakeDb.tables.task_transfer[0]).toMatchObject({
      id: "transfer-123",
      direction: "outgoing",
      status: "pending",
      source_peer_id: "peer-real-source",
      target_peer_id: "peer-target",
      source_task_id: "task-source",
      local_task_id: "task-source",
      payload_json: expect.any(String),
    });
  });

  it("includes the source resume session id in the outgoing payload", async () => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const fakeDb = createTransferDb({});

    await store.init(fakeDb);
    store.repos = [buildRepo()];
    store.items = [buildItem()];
    store.items[0]!.agent_provider = "codex";
    store.items[0]!.agent_session_id = "019d9a8c-9f39-7240-818f-88367a7c31df";

    loadSessionRecoveryStateMock.mockResolvedValue(null);

    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd === "prepare_outgoing_transfer") {
        const payload = args?.payload as Record<string, unknown> | undefined;
        if (payload?.phase === "preflight") {
          return {
            transferId: "transfer-123",
            sourcePeerId: "peer-real-source",
            targetHasRepo: true,
          };
        }
        return { ok: true };
      }
      return null;
    });

    await expect(store.pushTaskToPeer("task-source", "peer-target")).resolves.toBeUndefined();

    const prepareCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "prepare_outgoing_transfer");
    expect(prepareCalls[1]?.[1]).toMatchObject({
      payload: {
        phase: "commit",
        transferId: "transfer-123",
        payload: {
          task: {
            resume_session_id: "019d9a8c-9f39-7240-818f-88367a7c31df",
          },
        },
      },
    });
  });

  it("stages the local codex rollout file and includes it in the outgoing payload", async () => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const fakeDb = createTransferDb({});

    await store.init(fakeDb);
    store.repos = [buildRepo()];
    store.items = [buildItem()];
    store.items[0]!.agent_provider = "codex";
    store.items[0]!.agent_session_id = "019d9a8c-9f39-7240-818f-88367a7c31df";

    loadSessionRecoveryStateMock.mockResolvedValue(null);

    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd === "prepare_outgoing_transfer") {
        const payload = args?.payload as Record<string, unknown> | undefined;
        if (payload?.phase === "preflight") {
          return {
            transferId: "transfer-123",
            sourcePeerId: "peer-real-source",
            targetHasRepo: true,
          };
        }
        return { ok: true };
      }
      if (cmd === "read_env_var") {
        return "/Users/tester";
      }
      if (cmd === "file_exists") {
        return true;
      }
      if (cmd === "list_dir") {
        const path = args?.path;
        if (path === "/Users/tester/.codex/sessions") return ["2026"];
        if (path === "/Users/tester/.codex/sessions/2026") return ["04"];
        if (path === "/Users/tester/.codex/sessions/2026/04") return ["18"];
        if (path === "/Users/tester/.codex/sessions/2026/04/18") {
          return ["rollout-2026-04-18T06-27-04-019d9a8c-9f39-7240-818f-88367a7c31df.jsonl"];
        }
        return [];
      }
      if (cmd === "stage_transfer_artifact") {
        return {
          transferId: "transfer-123",
          artifactId: "transfer-123-codex-rollout",
        };
      }
      return null;
    });

    await expect(store.pushTaskToPeer("task-source", "peer-target")).resolves.toBeUndefined();

    expect(invokeMock).toHaveBeenCalledWith("stage_transfer_artifact", {
      transferId: "transfer-123",
      artifactId: "transfer-123-codex-rollout",
      path: "/Users/tester/.codex/sessions/2026/04/18/rollout-2026-04-18T06-27-04-019d9a8c-9f39-7240-818f-88367a7c31df.jsonl",
    });

    const prepareCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "prepare_outgoing_transfer");
    expect(prepareCalls[1]?.[1]).toMatchObject({
      payload: {
        phase: "commit",
        transferId: "transfer-123",
        payload: {
          task: {
            resume_session_id: "019d9a8c-9f39-7240-818f-88367a7c31df",
          },
          artifacts: [{
            artifact_id: "transfer-123-codex-rollout",
            provider: "codex",
            kind: "session-rollout",
            home_rel_path: ".codex/sessions/2026/04/18/rollout-2026-04-18T06-27-04-019d9a8c-9f39-7240-818f-88367a7c31df.jsonl",
          }],
        },
      },
    });
  });

  it("stages the local claude task directory and includes it in the outgoing payload", async () => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const fakeDb = createTransferDb({});

    await store.init(fakeDb);
    store.repos = [buildRepo()];
    store.items = [buildItem()];
    store.items[0]!.agent_provider = "claude";
    store.items[0]!.agent_session_id = "364643cc-5e6d-48fc-86ca-ca7764380900";

    loadSessionRecoveryStateMock.mockResolvedValue(null);

    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd === "prepare_outgoing_transfer") {
        const payload = args?.payload as Record<string, unknown> | undefined;
        if (payload?.phase === "preflight") {
          return {
            transferId: "transfer-123",
            sourcePeerId: "peer-real-source",
            targetHasRepo: true,
          };
        }
        return { ok: true };
      }
      if (cmd === "read_env_var") {
        return "/Users/tester";
      }
      if (cmd === "file_exists") {
        return true;
      }
      if (cmd === "run_script") {
        return "";
      }
      if (cmd === "stage_transfer_artifact") {
        return {
          transferId: "transfer-123",
          artifactId: "transfer-123-claude-session",
        };
      }
      return null;
    });

    await expect(store.pushTaskToPeer("task-source", "peer-target")).resolves.toBeUndefined();

    expect(invokeMock).toHaveBeenCalledWith("run_script", {
      script: expect.stringContaining("tar -C '/Users/tester/.claude/tasks' -czf '/tmp/kanna-transfer-transfer-123-claude-session.tar.gz' '364643cc-5e6d-48fc-86ca-ca7764380900'"),
      cwd: "/tmp/repo-1",
      env: expect.objectContaining({
        KANNA_WORKTREE: "1",
      }),
    });
    expect(invokeMock).toHaveBeenCalledWith("stage_transfer_artifact", {
      transferId: "transfer-123",
      artifactId: "transfer-123-claude-session",
      path: "/tmp/kanna-transfer-transfer-123-claude-session.tar.gz",
    });

    const prepareCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "prepare_outgoing_transfer");
    expect(prepareCalls[1]?.[1]).toMatchObject({
      payload: {
        phase: "commit",
        transferId: "transfer-123",
        payload: {
          artifacts: [{
            artifact_id: "transfer-123-claude-session",
            provider: "claude",
            kind: "session-archive",
            materialization: "extract-tar-gz",
            home_rel_path: ".claude/tasks/364643cc-5e6d-48fc-86ca-ca7764380900",
          }],
        },
      },
    });
  });

  it("stages the local copilot session-state directory and includes it in the outgoing payload", async () => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const fakeDb = createTransferDb({});

    await store.init(fakeDb);
    store.repos = [buildRepo()];
    store.items = [buildItem()];
    store.items[0]!.agent_provider = "copilot";
    store.items[0]!.agent_session_id = "5fc2bd17-1d1b-4ae9-bed8-011fa4011100";

    loadSessionRecoveryStateMock.mockResolvedValue(null);

    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd === "prepare_outgoing_transfer") {
        const payload = args?.payload as Record<string, unknown> | undefined;
        if (payload?.phase === "preflight") {
          return {
            transferId: "transfer-123",
            sourcePeerId: "peer-real-source",
            targetHasRepo: true,
          };
        }
        return { ok: true };
      }
      if (cmd === "read_env_var") {
        return "/Users/tester";
      }
      if (cmd === "file_exists") {
        return true;
      }
      if (cmd === "run_script") {
        return "";
      }
      if (cmd === "stage_transfer_artifact") {
        return {
          transferId: "transfer-123",
          artifactId: "transfer-123-copilot-session",
        };
      }
      return null;
    });

    await expect(store.pushTaskToPeer("task-source", "peer-target")).resolves.toBeUndefined();

    expect(invokeMock).toHaveBeenCalledWith("run_script", {
      script: expect.stringContaining("tar -C '/Users/tester/.copilot/session-state' -czf '/tmp/kanna-transfer-transfer-123-copilot-session.tar.gz' '5fc2bd17-1d1b-4ae9-bed8-011fa4011100'"),
      cwd: "/tmp/repo-1",
      env: expect.objectContaining({
        KANNA_WORKTREE: "1",
      }),
    });
    expect(invokeMock).toHaveBeenCalledWith("stage_transfer_artifact", {
      transferId: "transfer-123",
      artifactId: "transfer-123-copilot-session",
      path: "/tmp/kanna-transfer-transfer-123-copilot-session.tar.gz",
    });

    const prepareCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "prepare_outgoing_transfer");
    expect(prepareCalls[1]?.[1]).toMatchObject({
      payload: {
        phase: "commit",
        transferId: "transfer-123",
        payload: {
          artifacts: [{
            artifact_id: "transfer-123-copilot-session",
            provider: "copilot",
            kind: "session-archive",
            materialization: "extract-tar-gz",
            home_rel_path: ".copilot/session-state/5fc2bd17-1d1b-4ae9-bed8-011fa4011100",
          }],
        },
      },
    });
  });

  it("stages a git bundle before committing bundle-repo transfers", async () => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const fakeDb = createTransferDb({});

    await store.init(fakeDb);
    store.repos = [buildRepo()];
    store.items = [buildItem()];

    loadSessionRecoveryStateMock.mockResolvedValue(null);

    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd === "prepare_outgoing_transfer") {
        const payload = args?.payload as Record<string, unknown> | undefined;
        if (payload?.phase === "preflight") {
          return {
            transferId: "transfer-123",
            sourcePeerId: "peer-real-source",
            targetHasRepo: false,
          };
        }
        return { ok: true };
      }
      if (cmd === "git_remote_url") {
        return null;
      }
      if (cmd === "run_script") {
        return "";
      }
      if (cmd === "stage_transfer_artifact") {
        return {
          transferId: "transfer-123",
          artifactId: "artifact-123",
        };
      }
      return null;
    });

    await expect(store.pushTaskToPeer("task-source", "peer-target")).resolves.toBeUndefined();

    expect(invokeMock).toHaveBeenCalledWith("run_script", {
      script: expect.stringContaining("git bundle create"),
      cwd: "/tmp/repo-1",
      env: expect.objectContaining({
        KANNA_WORKTREE: "1",
      }),
    });
    expect(invokeMock).toHaveBeenCalledWith("stage_transfer_artifact", {
      transferId: "transfer-123",
      artifactId: expect.any(String),
      path: expect.stringContaining(".bundle"),
    });

    const prepareCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "prepare_outgoing_transfer");
    expect(prepareCalls[1]?.[1]).toEqual({
      payload: {
        phase: "commit",
        transferId: "transfer-123",
        payload: expect.objectContaining({
          repo: expect.objectContaining({
            mode: "bundle-repo",
            bundle: {
              artifact_id: expect.any(String),
              filename: expect.stringContaining(".bundle"),
              ref_name: "refs/heads/task-task-source",
            },
          }),
        }),
      },
    });
  });
});

describe("recordIncomingTransfer", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    loadSessionRecoveryStateMock.mockReset();
  });

  it("records a pending incoming transfer from the transfer-request event", async () => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const fakeDb = createTransferDb({});

    await store.init(fakeDb);

    const request = parseIncomingTransferRequest({
      type: "incoming_transfer_request",
      transfer_id: "transfer-1",
      source_peer_id: "peer-source",
      source_task_id: "task-source",
      source_name: "Primary",
      payload: {
        task: {
          source_task_id: "task-source",
          source_peer_id: "peer-source",
          prompt: "Fix handoff",
          stage: "in progress",
          branch: "task-source",
          pipeline: "default",
          display_name: null,
          base_ref: "main",
          agent_type: "agent",
          agent_provider: "claude",
        },
        repo: {
          mode: "reuse-local",
          remote_url: "git@github.com:jemdiggity/kanna.git",
          path: "/tmp/repo-1",
          name: "repo-1",
          default_branch: "main",
        },
        recovery: null,
        target_peer_id: "peer-target",
      },
    });

    await store.recordIncomingTransfer(request);

    expect(fakeDb.tables.task_transfer[0]).toMatchObject({
      id: "transfer-1",
      direction: "incoming",
      status: "pending",
      source_peer_id: "peer-source",
      source_task_id: "task-source",
      payload_json: expect.any(String),
    });
  });

  it("ignores duplicate transfer ids so later windows still proceed", async () => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const fakeDb = createTransferDb({});

    await store.init(fakeDb);

    const request = parseIncomingTransferRequest({
      type: "incoming_transfer_request",
      transfer_id: "transfer-1",
      source_peer_id: "peer-source",
      source_task_id: "task-source",
      source_name: "Primary",
      payload: {
        task: {
          source_task_id: "task-source",
          source_peer_id: "peer-source",
          prompt: "Fix handoff",
          stage: "in progress",
          branch: "task-source",
          pipeline: "default",
          display_name: null,
          base_ref: "main",
          agent_type: "agent",
          agent_provider: "claude",
        },
        repo: {
          mode: "reuse-local",
          remote_url: "git@github.com:jemdiggity/kanna.git",
          path: "/tmp/repo-1",
          name: "repo-1",
          default_branch: "main",
        },
        recovery: null,
        target_peer_id: "peer-target",
      },
    });

    await expect(store.recordIncomingTransfer(request)).resolves.toBeUndefined();
    await expect(store.recordIncomingTransfer(request)).resolves.toBeUndefined();
  });
});

describe("incoming transfer approval", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    loadSessionRecoveryStateMock.mockReset();
    vi.useRealTimers();
  });

  it("requests source finalization before importing an approved transfer", async () => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const payload = buildIncomingTransferPayload();
    const finalizedPayload = {
      ...payload,
      task: {
        ...payload.task,
        resume_session_id: "019d-final",
      },
    };
    const fakeDb = createTransferDb({
      transfers: [{
        id: "transfer-1",
        direction: "incoming",
        status: "pending",
        source_peer_id: "peer-source",
        target_peer_id: null,
        source_task_id: "task-source",
        local_task_id: null,
        started_at: new Date().toISOString(),
        completed_at: null,
        error: null,
        payload_json: JSON.stringify(payload),
      }],
    });

    await store.init(fakeDb);

    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd === "finalize_outgoing_transfer") {
        return {
          transferId: "transfer-1",
          payload: finalizedPayload,
          finalizedCleanly: true,
        };
      }
      if (cmd === "file_exists") {
        return (args?.path as string) === "/tmp/repo-1";
      }
      if (cmd === "which_binary") {
        return args?.name === "claude" ? "/usr/bin/claude" : null;
      }
      if (cmd === "git_default_branch") {
        return "main";
      }
      if (cmd === "git_list_base_branches") {
        return ["origin/main", "main"];
      }
      if (cmd === "git_fetch") {
        return null;
      }
      if (cmd === "git_worktree_add" || cmd === "spawn_agent_session") {
        return null;
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    await store.approveIncomingTransfer("transfer-1");

    expect(invokeMock).toHaveBeenCalledWith("finalize_outgoing_transfer", {
      transferId: "transfer-1",
    });
    expect(fakeDb.tables.pipeline_item[0]).toMatchObject({
      prompt: "Fix handoff",
      display_name: "Transferred task",
    });
  });

  it("approves a pending incoming transfer into a new local task and provenance row", async () => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const payload = buildIncomingTransferPayload();
    const fakeDb = createTransferDb({
      transfers: [{
        id: "transfer-1",
        direction: "incoming",
        status: "pending",
        source_peer_id: "peer-source",
        target_peer_id: null,
        source_task_id: "task-source",
        local_task_id: null,
        started_at: new Date().toISOString(),
        completed_at: null,
        error: null,
        payload_json: JSON.stringify(payload),
      }],
    });

    await store.init(fakeDb);

    mockIncomingTransferApprovalInvoke(payload, async (cmd, args) => {
      if (cmd === "file_exists") {
        return (args?.path as string) === "/tmp/repo-1";
      }
      if (cmd === "which_binary") {
        return args?.name === "claude" ? "/usr/bin/claude" : null;
      }
      if (cmd === "git_worktree_add" || cmd === "spawn_agent_session") {
        return null;
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    const localTaskId = await store.approveIncomingTransfer("transfer-1");
    await flushBackgroundSetup();

    expect(typeof localTaskId).toBe("string");
    expect(fakeDb.tables.repo).toHaveLength(1);
    expect(fakeDb.tables.repo[0]?.path).toBe("/tmp/repo-1");
    expect(fakeDb.tables.pipeline_item[0]).toMatchObject({
      id: localTaskId,
      repo_id: fakeDb.tables.repo[0]?.id,
      prompt: "Fix handoff",
      branch: localTaskId ? `task-${localTaskId}` : undefined,
      stage: "in progress",
      display_name: "Transferred task",
    });
    expect(fakeDb.tables.task_transfer[0]).toMatchObject({
      id: "transfer-1",
      status: "completed",
      local_task_id: localTaskId,
      error: null,
    });
    expect(fakeDb.tables.task_transfer_provenance[0]).toMatchObject({
      pipeline_item_id: localTaskId,
      source_peer_id: "peer-source",
      source_task_id: "task-source",
      source_machine_task_label: "task-source",
    });
  });

  it("clones the repo remotely before importing a clone-remote transfer", async () => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const payload = buildIncomingTransferPayload();
    payload.repo = {
      mode: "clone-remote",
      remote_url: "git@github.com:jemdiggity/kanna.git",
      path: null,
      name: "repo-1",
      default_branch: "main",
      bundle: null,
    };
    const fakeDb = createTransferDb({
      transfers: [{
        id: "transfer-1",
        direction: "incoming",
        status: "pending",
        source_peer_id: "peer-source",
        target_peer_id: null,
        source_task_id: "task-source",
        local_task_id: null,
        started_at: new Date().toISOString(),
        completed_at: null,
        error: null,
        payload_json: JSON.stringify(payload),
      }],
    });

    await store.init(fakeDb);

    mockIncomingTransferApprovalInvoke(payload, async (cmd, args) => {
      if (cmd === "read_env_var" && args?.name === "HOME") return "/Users/test";
      if (cmd === "get_app_data_dir") return "/tmp/kanna-mock-data";
      if (cmd === "file_exists") return false;
      if (
        cmd === "ensure_directory" ||
        cmd === "git_clone" ||
        cmd === "git_worktree_add" ||
        cmd === "spawn_agent_session"
      ) {
        return null;
      }
      if (cmd === "which_binary") {
        return "/usr/bin/claude";
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    const localTaskId = await store.approveIncomingTransfer("transfer-1");
    await flushBackgroundSetup();

    expect(invokeMock).toHaveBeenCalledWith("git_clone", {
      url: "git@github.com:jemdiggity/kanna.git",
      destination: "/Users/test/.kanna/repos/repo-1",
    });
    expect(typeof localTaskId).toBe("string");
  });

  it("reuses an existing imported repo with the same remote URL before cloning", async () => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const payload = buildIncomingTransferPayload();
    payload.repo = {
      mode: "clone-remote",
      remote_url: "git@github.com:jemdiggity/kanna.git",
      path: null,
      name: "repo-1",
      default_branch: "main",
      bundle: null,
    };
    const existingRepo = {
      ...buildRepo(),
      id: "repo-existing",
      path: "/tmp/repo-existing",
    };
    const fakeDb = createTransferDb({
      repos: [existingRepo],
      transfers: [{
        id: "transfer-1",
        direction: "incoming",
        status: "pending",
        source_peer_id: "peer-source",
        target_peer_id: null,
        source_task_id: "task-source",
        local_task_id: null,
        started_at: new Date().toISOString(),
        completed_at: null,
        error: null,
        payload_json: JSON.stringify(payload),
      }],
    });

    await store.init(fakeDb);

    mockIncomingTransferApprovalInvoke(payload, async (cmd, args) => {
      if (cmd === "git_remote_url") {
        if (args?.repoPath === "/tmp/repo-existing") {
          return "git@github.com:jemdiggity/kanna.git";
        }
        return null;
      }
      if (cmd === "which_binary") {
        return "/usr/bin/claude";
      }
      if (cmd === "git_worktree_add" || cmd === "spawn_agent_session") {
        return null;
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    const localTaskId = await store.approveIncomingTransfer("transfer-1");
    await flushBackgroundSetup();

    expect(typeof localTaskId).toBe("string");
    expect(invokeMock).not.toHaveBeenCalledWith("git_clone", expect.anything());
    expect(fakeDb.tables.repo).toHaveLength(1);
    expect(fakeDb.tables.pipeline_item[0]?.repo_id).toBe("repo-existing");
  });

  it("materializes the repo from a fetched bundle before importing a bundle-repo transfer", async () => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const payload = buildIncomingTransferPayload();
    payload.repo = {
      mode: "bundle-repo",
      remote_url: null,
      path: null,
      name: "repo-1",
      default_branch: "main",
      bundle: {
        artifact_id: "artifact-1",
        filename: "transfer-1.bundle",
        ref_name: "refs/heads/task-source",
      },
    };
    const fakeDb = createTransferDb({
      transfers: [{
        id: "transfer-1",
        direction: "incoming",
        status: "pending",
        source_peer_id: "peer-source",
        target_peer_id: null,
        source_task_id: "task-source",
        local_task_id: null,
        started_at: new Date().toISOString(),
        completed_at: null,
        error: null,
        payload_json: JSON.stringify(payload),
      }],
    });

    await store.init(fakeDb);

    mockIncomingTransferApprovalInvoke(payload, async (cmd, args) => {
      if (cmd === "read_env_var" && args?.name === "HOME") return "/Users/test";
      if (cmd === "get_app_data_dir") return "/tmp/kanna-mock-data";
      if (cmd === "file_exists") return false;
      if (cmd === "fetch_transfer_artifact") {
        return { path: "/tmp/fetched/transfer-1.bundle" };
      }
      if (
        cmd === "ensure_directory" ||
        cmd === "git_init" ||
        cmd === "git_worktree_add" ||
        cmd === "spawn_agent_session"
      ) {
        return null;
      }
      if (cmd === "run_script") {
        return "";
      }
      if (cmd === "which_binary") {
        return "/usr/bin/claude";
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    const localTaskId = await store.approveIncomingTransfer("transfer-1");
    await flushBackgroundSetup();

    expect(invokeMock).toHaveBeenCalledWith("fetch_transfer_artifact", {
      transferId: "transfer-1",
      artifactId: "artifact-1",
    });
    expect(invokeMock).toHaveBeenCalledWith("git_init", {
      path: "/Users/test/.kanna/repos/repo-1",
    });
    expect(invokeMock).toHaveBeenCalledWith("run_script", {
      script: expect.stringContaining("git fetch"),
      cwd: expect.stringContaining("/repo-1"),
      env: expect.objectContaining({
        KANNA_WORKTREE: "1",
      }),
    });
    expect(typeof localTaskId).toBe("string");
  });

  it("restores codex resume state when importing a transferred codex task", async () => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const payload = buildIncomingTransferPayload();
    payload.task.agent_provider = "codex";
    payload.task.agent_type = "pty";
    payload.task.resume_session_id = "019d9a8c-9f39-7240-818f-88367a7c31df";
    Object.assign(payload, {
      artifacts: [{
        artifact_id: "artifact-codex-rollout",
        filename: "rollout-2026-04-18T06-27-04-019d9a8c-9f39-7240-818f-88367a7c31df.jsonl",
        provider: "codex",
        kind: "session-rollout",
        home_rel_path: ".codex/sessions/2026/04/18/rollout-2026-04-18T06-27-04-019d9a8c-9f39-7240-818f-88367a7c31df.jsonl",
      }],
    });
    payload.recovery = {
      serialized: "prompt> ",
      cols: 80,
      rows: 24,
      cursorRow: 0,
      cursorCol: 8,
      cursorVisible: true,
      savedAt: 123,
      sequence: 4,
    };
    const fakeDb = createTransferDb({
      transfers: [{
        id: "transfer-1",
        direction: "incoming",
        status: "pending",
        source_peer_id: "peer-source",
        target_peer_id: null,
        source_task_id: "task-source",
        local_task_id: null,
        started_at: new Date().toISOString(),
        completed_at: null,
        error: null,
        payload_json: JSON.stringify(payload),
      }],
    });

    await store.init(fakeDb);

    mockIncomingTransferApprovalInvoke(payload, async (cmd, args) => {
      if (cmd === "file_exists") {
        return (args?.path as string) === "/tmp/repo-1";
      }
      if (cmd === "read_text_file") {
        return "";
      }
      if (cmd === "read_builtin_resource") {
        throw new Error("missing builtin resource");
      }
      if (cmd === "git_default_branch") {
        return "main";
      }
      if (cmd === "which_binary") {
        if (args?.name === "codex") return "/usr/bin/codex";
        if (args?.name === "kanna-cli") return "/Applications/Kanna.app/Contents/MacOS/kanna-cli";
        return null;
      }
      if (cmd === "get_app_data_dir") {
        return "/tmp/kanna-mock-data";
      }
      if (cmd === "get_pipeline_socket_path") {
        return "/tmp/kanna.sock";
      }
      if (cmd === "fetch_transfer_artifact") {
        return {
          transferId: "transfer-1",
          artifactId: "artifact-codex-rollout",
          path: "/tmp/fetched-rollout.jsonl",
        };
      }
      if (cmd === "read_env_var") {
        if (args?.name === "HOME") return "/Users/tester";
        if (args?.name === "PATH") return "/usr/local/bin:/usr/bin:/bin";
        if (args?.name === "KANNA_MOBILE_SERVER_PORT") return "";
        return "";
      }
      if (
        cmd === "ensure_directory" ||
        cmd === "copy_file" ||
        cmd === "git_worktree_add" ||
        cmd === "seed_session_recovery_state" ||
        cmd === "acknowledge_incoming_transfer_commit"
      ) {
        return null;
      }
      if (cmd === "spawn_session") {
        return null;
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    const localTaskId = await store.approveIncomingTransfer("transfer-1");
    await flushBackgroundSetup();

    expect(fakeDb.tables.pipeline_item[0]).toMatchObject({
      id: localTaskId,
      agent_session_id: "019d9a8c-9f39-7240-818f-88367a7c31df",
    });
    expect(invokeMock).toHaveBeenCalledWith("seed_session_recovery_state", {
      sessionId: localTaskId,
      serialized: "prompt> ",
      cols: 80,
      rows: 24,
      cursorRow: 0,
      cursorCol: 8,
      cursorVisible: true,
    });
    expect(invokeMock).toHaveBeenCalledWith(
      "spawn_session",
      expect.objectContaining({
        sessionId: localTaskId,
        agentProvider: "codex",
        args: expect.arrayContaining([
          expect.stringMatching(/codex resume(?: [^']+)* '019d9a8c-9f39-7240-818f-88367a7c31df'/),
        ]),
        env: expect.objectContaining({
          PATH: "/Applications/Kanna.app/Contents/MacOS:/usr/local/bin:/usr/bin:/bin",
        }),
      }),
    );
  });

  it("imports a transferred codex rollout artifact before resuming", async () => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const payload = buildIncomingTransferPayload() as ReturnType<typeof buildIncomingTransferPayload> & {
      artifacts?: Array<Record<string, unknown>>;
    };
    payload.task.agent_provider = "codex";
    payload.task.agent_type = "pty";
    payload.task.resume_session_id = "019d9a8c-9f39-7240-818f-88367a7c31df";
    payload.artifacts = [{
      artifact_id: "artifact-codex-rollout",
      filename: "rollout-2026-04-18T06-27-04-019d9a8c-9f39-7240-818f-88367a7c31df.jsonl",
      provider: "codex",
      kind: "session-rollout",
      home_rel_path: ".codex/sessions/2026/04/18/rollout-2026-04-18T06-27-04-019d9a8c-9f39-7240-818f-88367a7c31df.jsonl",
    }];
    const fakeDb = createTransferDb({
      transfers: [{
        id: "transfer-1",
        direction: "incoming",
        status: "pending",
        source_peer_id: "peer-source",
        target_peer_id: null,
        source_task_id: "task-source",
        local_task_id: null,
        started_at: new Date().toISOString(),
        completed_at: null,
        error: null,
        payload_json: JSON.stringify(payload),
      }],
    });

    await store.init(fakeDb);

    mockIncomingTransferApprovalInvoke(payload, async (cmd, args) => {
      if (cmd === "file_exists") {
        return (args?.path as string) === "/tmp/repo-1";
      }
      if (cmd === "read_text_file") {
        return "";
      }
      if (cmd === "read_builtin_resource") {
        throw new Error("missing builtin resource");
      }
      if (cmd === "git_default_branch") {
        return "main";
      }
      if (cmd === "which_binary") {
        if (args?.name === "codex") return "/usr/bin/codex";
        if (args?.name === "kanna-cli") return "/Applications/Kanna.app/Contents/MacOS/kanna-cli";
        return null;
      }
      if (cmd === "get_app_data_dir") {
        return "/tmp/kanna-mock-data";
      }
      if (cmd === "get_pipeline_socket_path") {
        return "/tmp/kanna.sock";
      }
      if (cmd === "read_env_var") {
        if (args?.name === "HOME") return "/Users/tester";
        if (args?.name === "PATH") return "/usr/local/bin:/usr/bin:/bin";
        if (args?.name === "KANNA_MOBILE_SERVER_PORT") return "";
        return "";
      }
      if (cmd === "fetch_transfer_artifact") {
        return {
          transferId: "transfer-1",
          artifactId: "artifact-codex-rollout",
          path: "/tmp/fetched-rollout.jsonl",
        };
      }
      if (cmd === "read_env_var") {
        return "/Users/tester";
      }
      if (
        cmd === "ensure_directory" ||
        cmd === "copy_file" ||
        cmd === "seed_session_recovery_state" ||
        cmd === "acknowledge_incoming_transfer_commit"
      ) {
        return null;
      }
      if (cmd === "git_worktree_add") {
        return null;
      }
      if (cmd === "spawn_session") {
        return null;
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    const localTaskId = await store.approveIncomingTransfer("transfer-1");
    await flushBackgroundSetup();

    expect(localTaskId).toEqual(expect.any(String));
    expect(invokeMock).toHaveBeenCalledWith("fetch_transfer_artifact", {
      transferId: "transfer-1",
      artifactId: "artifact-codex-rollout",
    });
    expect(invokeMock).toHaveBeenCalledWith("ensure_directory", {
      path: "/Users/tester/.codex/sessions/2026/04/18",
    });
    expect(invokeMock).toHaveBeenCalledWith("copy_file", {
      src: "/tmp/fetched-rollout.jsonl",
      dst: "/Users/tester/.codex/sessions/2026/04/18/rollout-2026-04-18T06-27-04-019d9a8c-9f39-7240-818f-88367a7c31df.jsonl",
    });
    expect(invokeMock).toHaveBeenCalledWith(
      "spawn_session",
      expect.objectContaining({
        sessionId: localTaskId,
        agentProvider: "codex",
        args: expect.arrayContaining([
          expect.stringMatching(/codex resume(?: [^']+)* '019d9a8c-9f39-7240-818f-88367a7c31df'/),
        ]),
        env: expect.objectContaining({
          PATH: "/Applications/Kanna.app/Contents/MacOS:/usr/local/bin:/usr/bin:/bin",
        }),
      }),
    );
  });

  it("falls back to a fresh codex launch when no rollout artifact is available", async () => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const payload = buildIncomingTransferPayload();
    payload.task.agent_provider = "codex";
    payload.task.agent_type = "pty";
    payload.task.resume_session_id = "019d9a8c-9f39-7240-818f-88367a7c31df";
    const fakeDb = createTransferDb({
      transfers: [{
        id: "transfer-1",
        direction: "incoming",
        status: "pending",
        source_peer_id: "peer-source",
        target_peer_id: null,
        source_task_id: "task-source",
        local_task_id: null,
        started_at: new Date().toISOString(),
        completed_at: null,
        error: null,
        payload_json: JSON.stringify(payload),
      }],
    });

    await store.init(fakeDb);

    mockIncomingTransferApprovalInvoke(payload, async (cmd, args) => {
      if (cmd === "file_exists") {
        return (args?.path as string) === "/tmp/repo-1";
      }
      if (cmd === "read_text_file") {
        return "";
      }
      if (cmd === "read_builtin_resource") {
        throw new Error("missing builtin resource");
      }
      if (cmd === "git_default_branch") {
        return "main";
      }
      if (cmd === "which_binary") {
        return args?.name === "codex" ? "/usr/bin/codex" : null;
      }
      if (cmd === "get_app_data_dir") {
        return "/tmp/kanna-mock-data";
      }
      if (cmd === "get_pipeline_socket_path") {
        return "/tmp/kanna.sock";
      }
      if (
        cmd === "git_worktree_add" ||
        cmd === "acknowledge_incoming_transfer_commit"
      ) {
        return null;
      }
      if (cmd === "spawn_session") {
        return null;
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    const localTaskId = await store.approveIncomingTransfer("transfer-1");
    await flushBackgroundSetup();

    expect(fakeDb.tables.pipeline_item[0]).toMatchObject({
      id: localTaskId,
      agent_session_id: null,
    });
    const spawnCall = invokeMock.mock.calls.find(([cmd]) => cmd === "spawn_session");
    expect(spawnCall).toBeTruthy();
    expect(JSON.stringify(spawnCall?.[1])).not.toContain("codex resume");
  });

  it.each([
    {
      provider: "claude" as const,
      resumeSessionId: "364643cc-5e6d-48fc-86ca-ca7764380900",
      forbiddenText: "--resume 364643cc-5e6d-48fc-86ca-ca7764380900",
      binary: "claude",
    },
    {
      provider: "copilot" as const,
      resumeSessionId: "5fc2bd17-1d1b-4ae9-bed8-011fa4011100",
      forbiddenText: "--resume=5fc2bd17-1d1b-4ae9-bed8-011fa4011100",
      binary: "copilot",
    },
  ])("falls back to a fresh $provider launch when no session artifact is available", async ({
    provider,
    resumeSessionId,
    forbiddenText,
    binary,
  }) => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const payload = buildIncomingTransferPayload();
    payload.task.agent_provider = provider;
    payload.task.agent_type = "pty";
    payload.task.resume_session_id = resumeSessionId;
    const fakeDb = createTransferDb({
      transfers: [{
        id: "transfer-1",
        direction: "incoming",
        status: "pending",
        source_peer_id: "peer-source",
        target_peer_id: null,
        source_task_id: "task-source",
        local_task_id: null,
        started_at: new Date().toISOString(),
        completed_at: null,
        error: null,
        payload_json: JSON.stringify(payload),
      }],
    });

    await store.init(fakeDb);

    mockIncomingTransferApprovalInvoke(payload, async (cmd, args) => {
      if (cmd === "file_exists") {
        return (args?.path as string) === "/tmp/repo-1";
      }
      if (cmd === "read_text_file") {
        return "";
      }
      if (cmd === "read_builtin_resource") {
        throw new Error("missing builtin resource");
      }
      if (cmd === "git_default_branch") {
        return "main";
      }
      if (cmd === "which_binary") {
        return args?.name === binary ? `/usr/bin/${binary}` : null;
      }
      if (cmd === "get_app_data_dir") {
        return "/tmp/kanna-mock-data";
      }
      if (cmd === "get_pipeline_socket_path") {
        return "/tmp/kanna.sock";
      }
      if (
        cmd === "git_worktree_add" ||
        cmd === "acknowledge_incoming_transfer_commit"
      ) {
        return null;
      }
      if (cmd === "spawn_session") {
        return null;
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    const localTaskId = await store.approveIncomingTransfer("transfer-1");
    await flushBackgroundSetup();

    expect(fakeDb.tables.pipeline_item[0]).toMatchObject({
      id: localTaskId,
    });
    expect(fakeDb.tables.pipeline_item[0]?.agent_session_id).not.toBe(resumeSessionId);
    const spawnCall = invokeMock.mock.calls.find(([cmd]) => cmd === "spawn_session");
    expect(spawnCall).toBeTruthy();
    expect(JSON.stringify(spawnCall?.[1])).not.toContain(forbiddenText);
  });

  it("imports a transferred claude session archive before resuming", async () => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const payload = buildIncomingTransferPayload() as ReturnType<typeof buildIncomingTransferPayload> & {
      artifacts?: Array<Record<string, unknown>>;
    };
    payload.task.agent_provider = "claude";
    payload.task.agent_type = "pty";
    payload.task.resume_session_id = "364643cc-5e6d-48fc-86ca-ca7764380900";
    payload.artifacts = [{
      artifact_id: "artifact-claude-session",
      filename: "claude-session.tar.gz",
      provider: "claude",
      kind: "session-archive",
      materialization: "extract-tar-gz",
      home_rel_path: ".claude/tasks/364643cc-5e6d-48fc-86ca-ca7764380900",
    }];
    const fakeDb = createTransferDb({
      transfers: [{
        id: "transfer-1",
        direction: "incoming",
        status: "pending",
        source_peer_id: "peer-source",
        target_peer_id: null,
        source_task_id: "task-source",
        local_task_id: null,
        started_at: new Date().toISOString(),
        completed_at: null,
        error: null,
        payload_json: JSON.stringify(payload),
      }],
    });

    await store.init(fakeDb);

    mockIncomingTransferApprovalInvoke(payload, async (cmd, args) => {
      if (cmd === "file_exists") {
        return (args?.path as string) === "/tmp/repo-1";
      }
      if (cmd === "read_text_file") {
        return "";
      }
      if (cmd === "read_builtin_resource") {
        throw new Error("missing builtin resource");
      }
      if (cmd === "git_default_branch") {
        return "main";
      }
      if (cmd === "which_binary") {
        if (args?.name === "claude") return "/usr/bin/claude";
        if (args?.name === "codex") return "/usr/bin/codex";
        return null;
      }
      if (cmd === "get_app_data_dir") {
        return "/tmp/kanna-mock-data";
      }
      if (cmd === "get_pipeline_socket_path") {
        return "/tmp/kanna.sock";
      }
      if (cmd === "fetch_transfer_artifact") {
        return {
          transferId: "transfer-1",
          artifactId: "artifact-claude-session",
          path: "/tmp/fetched-claude-session.tar.gz",
        };
      }
      if (cmd === "read_env_var") {
        return "/Users/tester";
      }
      if (
        cmd === "ensure_directory" ||
        cmd === "git_worktree_add" ||
        cmd === "seed_session_recovery_state" ||
        cmd === "acknowledge_incoming_transfer_commit"
      ) {
        return null;
      }
      if (cmd === "run_script") {
        return "";
      }
      if (cmd === "spawn_session") {
        return null;
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    const localTaskId = await store.approveIncomingTransfer("transfer-1");
    await flushBackgroundSetup();

    expect(localTaskId).toEqual(expect.any(String));
    expect(invokeMock).toHaveBeenCalledWith("ensure_directory", {
      path: "/Users/tester/.claude/tasks",
    });
    expect(invokeMock).toHaveBeenCalledWith(
      "run_script",
      expect.objectContaining({
        script: expect.stringContaining("mktemp -d"),
        cwd: "/tmp/repo-1",
        env: expect.objectContaining({
          KANNA_WORKTREE: "1",
        }),
      }),
    );
    const claudeImportCall = invokeMock.mock.calls.find(([cmd, args]) =>
      cmd === "run_script" &&
      typeof args === "object" &&
      args !== null &&
      "script" in args &&
      typeof args.script === "string" &&
      args.script.includes("/tmp/fetched-claude-session.tar.gz"),
    );
    expect(claudeImportCall?.[1]).toMatchObject({
      script: expect.stringContaining("mv "),
    });
    expect(JSON.stringify(claudeImportCall?.[1])).not.toContain(
      "tar -xzf '/tmp/fetched-claude-session.tar.gz' -C '/Users/tester/.claude/tasks'",
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "spawn_session",
      expect.objectContaining({
        sessionId: localTaskId,
        agentProvider: "claude",
        args: expect.arrayContaining([
          expect.stringContaining("--resume 364643cc-5e6d-48fc-86ca-ca7764380900"),
        ]),
      }),
    );
  });

  it("imports a transferred copilot session archive before resuming", async () => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const payload = buildIncomingTransferPayload() as ReturnType<typeof buildIncomingTransferPayload> & {
      artifacts?: Array<Record<string, unknown>>;
    };
    payload.task.agent_provider = "copilot";
    payload.task.agent_type = "pty";
    payload.task.resume_session_id = "5fc2bd17-1d1b-4ae9-bed8-011fa4011100";
    payload.artifacts = [{
      artifact_id: "artifact-copilot-session",
      filename: "copilot-session.tar.gz",
      provider: "copilot",
      kind: "session-archive",
      materialization: "extract-tar-gz",
      home_rel_path: ".copilot/session-state/5fc2bd17-1d1b-4ae9-bed8-011fa4011100",
    }];
    const fakeDb = createTransferDb({
      transfers: [{
        id: "transfer-1",
        direction: "incoming",
        status: "pending",
        source_peer_id: "peer-source",
        target_peer_id: null,
        source_task_id: "task-source",
        local_task_id: null,
        started_at: new Date().toISOString(),
        completed_at: null,
        error: null,
        payload_json: JSON.stringify(payload),
      }],
    });

    await store.init(fakeDb);

    mockIncomingTransferApprovalInvoke(payload, async (cmd, args) => {
      if (cmd === "file_exists") {
        return (args?.path as string) === "/tmp/repo-1";
      }
      if (cmd === "read_text_file") {
        return "";
      }
      if (cmd === "read_builtin_resource") {
        throw new Error("missing builtin resource");
      }
      if (cmd === "git_default_branch") {
        return "main";
      }
      if (cmd === "which_binary") {
        return args?.name === "copilot" ? "/usr/bin/copilot" : null;
      }
      if (cmd === "get_app_data_dir") {
        return "/tmp/kanna-mock-data";
      }
      if (cmd === "get_pipeline_socket_path") {
        return "/tmp/kanna.sock";
      }
      if (cmd === "fetch_transfer_artifact") {
        return {
          transferId: "transfer-1",
          artifactId: "artifact-copilot-session",
          path: "/tmp/fetched-copilot-session.tar.gz",
        };
      }
      if (cmd === "read_env_var") {
        return "/Users/tester";
      }
      if (
        cmd === "ensure_directory" ||
        cmd === "git_worktree_add" ||
        cmd === "seed_session_recovery_state" ||
        cmd === "acknowledge_incoming_transfer_commit"
      ) {
        return null;
      }
      if (cmd === "run_script") {
        return "";
      }
      if (cmd === "spawn_session") {
        return null;
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    const localTaskId = await store.approveIncomingTransfer("transfer-1");
    await flushBackgroundSetup();

    expect(localTaskId).toEqual(expect.any(String));
    expect(invokeMock).toHaveBeenCalledWith("ensure_directory", {
      path: "/Users/tester/.copilot/session-state",
    });
    expect(invokeMock).toHaveBeenCalledWith(
      "run_script",
      expect.objectContaining({
        script: expect.stringContaining("mktemp -d"),
        cwd: "/tmp/repo-1",
        env: expect.objectContaining({
          KANNA_WORKTREE: "1",
        }),
      }),
    );
    const copilotImportCall = invokeMock.mock.calls.find(([cmd, args]) =>
      cmd === "run_script" &&
      typeof args === "object" &&
      args !== null &&
      "script" in args &&
      typeof args.script === "string" &&
      args.script.includes("/tmp/fetched-copilot-session.tar.gz"),
    );
    expect(copilotImportCall?.[1]).toMatchObject({
      script: expect.stringContaining("mv "),
    });
    expect(JSON.stringify(copilotImportCall?.[1])).not.toContain(
      "tar -xzf '/tmp/fetched-copilot-session.tar.gz' -C '/Users/tester/.copilot/session-state'",
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "spawn_session",
      expect.objectContaining({
        sessionId: localTaskId,
        agentProvider: "copilot",
        args: expect.arrayContaining([
          expect.stringContaining("--resume='5fc2bd17-1d1b-4ae9-bed8-011fa4011100'"),
        ]),
      }),
    );
  });

  it.each([
    {
      provider: "claude" as const,
      binary: "claude",
      resumeSessionId: "364643cc-5e6d-48fc-86ca-ca7764380900",
      artifactId: "artifact-claude-session",
      artifactPath: "/tmp/fetched-claude-session.tar.gz",
      homeRelPath: ".claude/tasks/364643cc-5e6d-48fc-86ca-ca7764380900",
      forbiddenText: "--resume 364643cc-5e6d-48fc-86ca-ca7764380900",
    },
    {
      provider: "copilot" as const,
      binary: "copilot",
      resumeSessionId: "5fc2bd17-1d1b-4ae9-bed8-011fa4011100",
      artifactId: "artifact-copilot-session",
      artifactPath: "/tmp/fetched-copilot-session.tar.gz",
      homeRelPath: ".copilot/session-state/5fc2bd17-1d1b-4ae9-bed8-011fa4011100",
      forbiddenText: "--resume=5fc2bd17-1d1b-4ae9-bed8-011fa4011100",
    },
  ])("falls back to a fresh $provider launch when the destination session already exists", async ({
    provider,
    binary,
    resumeSessionId,
    artifactId,
    artifactPath,
    homeRelPath,
    forbiddenText,
  }) => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const payload = buildIncomingTransferPayload() as ReturnType<typeof buildIncomingTransferPayload> & {
      artifacts?: Array<Record<string, unknown>>;
    };
    payload.task.agent_provider = provider;
    payload.task.agent_type = "pty";
    payload.task.resume_session_id = resumeSessionId;
    payload.artifacts = [{
      artifact_id: artifactId,
      filename: `${provider}-session.tar.gz`,
      provider,
      kind: "session-archive",
      materialization: "extract-tar-gz",
      home_rel_path: homeRelPath,
    }];
    const fakeDb = createTransferDb({
      transfers: [{
        id: "transfer-1",
        direction: "incoming",
        status: "pending",
        source_peer_id: "peer-source",
        target_peer_id: null,
        source_task_id: "task-source",
        local_task_id: null,
        started_at: new Date().toISOString(),
        completed_at: null,
        error: null,
        payload_json: JSON.stringify(payload),
      }],
    });

    await store.init(fakeDb);

    mockIncomingTransferApprovalInvoke(payload, async (cmd, args) => {
      if (cmd === "file_exists") {
        return (args?.path as string) === "/tmp/repo-1" ||
          (args?.path as string) === `/Users/tester/${homeRelPath}`;
      }
      if (cmd === "read_text_file") {
        return "";
      }
      if (cmd === "read_builtin_resource") {
        throw new Error("missing builtin resource");
      }
      if (cmd === "git_default_branch") {
        return "main";
      }
      if (cmd === "which_binary") {
        return args?.name === binary ? `/usr/bin/${binary}` : null;
      }
      if (cmd === "get_app_data_dir") {
        return "/tmp/kanna-mock-data";
      }
      if (cmd === "get_pipeline_socket_path") {
        return "/tmp/kanna.sock";
      }
      if (cmd === "fetch_transfer_artifact") {
        return {
          transferId: "transfer-1",
          artifactId,
          path: artifactPath,
        };
      }
      if (cmd === "read_env_var") {
        return "/Users/tester";
      }
      if (
        cmd === "git_worktree_add" ||
        cmd === "seed_session_recovery_state" ||
        cmd === "acknowledge_incoming_transfer_commit"
      ) {
        return null;
      }
      if (cmd === "spawn_session") {
        return null;
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    const localTaskId = await store.approveIncomingTransfer("transfer-1");
    await flushBackgroundSetup();

    expect(localTaskId).toEqual(expect.any(String));
    expect(invokeMock).not.toHaveBeenCalledWith("fetch_transfer_artifact", expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith("run_script", expect.anything());
    const spawnCall = invokeMock.mock.calls.find(([cmd]) => cmd === "spawn_session");
    expect(spawnCall).toBeTruthy();
    expect(JSON.stringify(spawnCall?.[1])).not.toContain(forbiddenText);
  });

  it("rejects a pending incoming transfer locally", async () => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const fakeDb = createTransferDb({
      transfers: [{
        id: "transfer-1",
        direction: "incoming",
        status: "pending",
        source_peer_id: "peer-source",
        target_peer_id: null,
        source_task_id: "task-source",
        local_task_id: null,
        started_at: new Date().toISOString(),
        completed_at: null,
        error: null,
        payload_json: JSON.stringify(buildIncomingTransferPayload()),
      }],
    });

    await store.init(fakeDb);
    await store.rejectIncomingTransfer("transfer-1");

    expect(fakeDb.tables.task_transfer[0]).toMatchObject({
      id: "transfer-1",
      status: "rejected",
      error: "Rejected locally",
    });
  });

  it("does not finalize the source when an incoming transfer is rejected", async () => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const fakeDb = createTransferDb({
      transfers: [{
        id: "transfer-1",
        direction: "incoming",
        status: "pending",
        source_peer_id: "peer-source",
        target_peer_id: null,
        source_task_id: "task-source",
        local_task_id: null,
        started_at: new Date().toISOString(),
        completed_at: null,
        error: null,
        payload_json: JSON.stringify(buildIncomingTransferPayload()),
      }],
    });

    await store.init(fakeDb);
    await store.rejectIncomingTransfer("transfer-1");

    expect(invokeMock).not.toHaveBeenCalledWith(
      "finalize_outgoing_transfer",
      expect.anything(),
    );
  });
});

describe("source transfer finalization", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    loadSessionRecoveryStateMock.mockReset();
    vi.useRealTimers();
  });

  it("best-effort finalizes a codex source transfer after signaling the session", async () => {
    vi.useFakeTimers();

    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const sourceItem = buildItem();
    sourceItem.agent_provider = "codex";
    sourceItem.agent_session_id = "019d-initial";
    const outgoingPayload = buildOutgoingTransferPayload({
      sourcePeerId: "peer-source",
      sourceTaskId: "task-source",
      targetPeerId: "peer-target",
      item: sourceItem,
      repoPath: "/tmp/repo-1",
      repoName: "repo-1",
      repoDefaultBranch: "main",
      repoRemoteUrl: null,
      recovery: null,
      artifacts: [],
      targetHasRepo: true,
      bundle: null,
    });
    const fakeDb = createTransferDb({
      repos: [buildRepo()],
      items: [sourceItem],
      transfers: [{
        id: "transfer-123",
        direction: "outgoing",
        status: "pending",
        source_peer_id: "peer-source",
        target_peer_id: "peer-target",
        source_task_id: "task-source",
        local_task_id: "task-source",
        started_at: new Date().toISOString(),
        completed_at: null,
        error: null,
        payload_json: JSON.stringify(outgoingPayload),
      }],
    });

    await store.init(fakeDb);
    store.repos = [buildRepo()];
    store.items = [sourceItem];
    loadSessionRecoveryStateMock.mockResolvedValue(null);

    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "signal_session") return null;
      return null;
    });

    const finalizePromise = store.finalizeOutgoingTransfer("transfer-123");
    await vi.advanceTimersByTimeAsync(1500);
    const result = await finalizePromise;

    expect(invokeMock).toHaveBeenCalledWith("signal_session", {
      sessionId: "task-source",
      signal: "SIGINT",
    });
    expect(result.transferId).toBe("transfer-123");
    expect(result.finalizedCleanly).toBe(false);
    expect(result.payload.task.source_task_id).toBe("task-source");
  });
});

describe("outgoing transfer commit acknowledgment", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    loadSessionRecoveryStateMock.mockReset();
  });

  it("marks the outgoing transfer completed and closes the source task", async () => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const repo = buildRepo();
    const sourceItem = buildItem(repo.id);
    const fakeDb = createTransferDb({
      repos: [repo],
      items: [sourceItem],
      transfers: [{
        id: "transfer-1",
        direction: "outgoing",
        status: "pending",
        source_peer_id: "peer-source",
        target_peer_id: "peer-target",
        source_task_id: "task-source",
        local_task_id: "task-source",
        started_at: new Date().toISOString(),
        completed_at: null,
        error: null,
        payload_json: JSON.stringify(buildIncomingTransferPayload()),
      }],
    });

    await store.init(fakeDb);
    store.repos = [repo];
    store.items = [sourceItem];

    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd === "kill_session" || cmd === "signal_session") return null;
      if (cmd === "list_dir") return [];
      if (
        cmd === "read_text_file"
        && args?.path === "/tmp/repo-1/.kanna-worktrees/task-task-source/.kanna/config.json"
      ) {
        throw new Error("failed to read '/tmp/repo-1/.kanna-worktrees/task-task-source/.kanna/config.json': No such file or directory");
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    await store.handleOutgoingTransferCommitted({
      transferId: "transfer-1",
      sourceTaskId: "task-source",
      destinationLocalTaskId: "task-imported",
    });

    expect(fakeDb.tables.task_transfer[0]).toMatchObject({
      id: "transfer-1",
      status: "completed",
      local_task_id: "task-source",
      error: null,
    });
    expect(fakeDb.tables.pipeline_item[0]).toMatchObject({
      id: "task-source",
      stage: "in progress",
    });
    expect(fakeDb.tables.pipeline_item[0]?.closed_at).not.toBeNull();
  });

  it("enters teardown on commit acknowledgment and sanitizes instance-scoped env", async () => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const repo = buildRepo();
    const sourceItem = buildItem(repo.id);
    const fakeDb = createTransferDb({
      repos: [repo],
      items: [sourceItem],
      transfers: [{
        id: "transfer-2",
        direction: "outgoing",
        status: "pending",
        source_peer_id: "peer-source",
        target_peer_id: "peer-target",
        source_task_id: "task-source",
        local_task_id: "task-source",
        started_at: new Date().toISOString(),
        completed_at: null,
        error: null,
        payload_json: JSON.stringify(buildIncomingTransferPayload()),
      }],
    });

    await store.init(fakeDb);
    store.repos = [repo];
    store.items = [sourceItem];

    let teardownSpawnArgs: Record<string, unknown> | null = null;

    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd === "kill_session" || cmd === "signal_session") return null;
      if (cmd === "list_dir") return [];
      if (cmd === "spawn_session") {
        teardownSpawnArgs = args as Record<string, unknown>;
        return null;
      }
      if (cmd === "attach_session_with_snapshot") return null;
      if (cmd === "get_app_data_dir") return "/tmp/kanna-mock-data";
      if (cmd === "get_pipeline_socket_path") return "/tmp/kanna-mock.sock";
      if (cmd === "read_text_file") {
        const path = args?.path as string | undefined;
        if (path === `${repo.path}/.kanna-worktrees/${sourceItem.branch}/.kanna/config.json`) {
          return JSON.stringify({
            teardown: ["./kd dev down --kill-daemon"],
          });
        }
        return "";
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    await store.handleOutgoingTransferCommitted({
      transferId: "transfer-2",
      sourceTaskId: "task-source",
      destinationLocalTaskId: "task-imported",
    });

    expect(fakeDb.tables.task_transfer[0]).toMatchObject({
      id: "transfer-2",
      status: "completed",
      local_task_id: "task-source",
      error: null,
    });
    expect(teardownSpawnArgs).toMatchObject({
      sessionId: "td-task-source",
      cwd: `${repo.path}/.kanna-worktrees/${sourceItem.branch}`,
      executable: "/bin/zsh",
      args: expect.arrayContaining(["--login", "-i", "-c"]),
      env: expect.objectContaining({
        KANNA_WORKTREE: "1",
        KANNA_TMUX_SESSION: "",
        KANNA_DB_NAME: "",
        KANNA_DB_PATH: "",
        KANNA_DAEMON_DIR: "",
        KANNA_TRANSFER_ROOT: "",
        KANNA_WEBDRIVER_PORT: "",
        KANNA_E2E_TARGET_WEBDRIVER_PORT: "",
      }),
    });
    const teardownArgs = teardownSpawnArgs?.args as string[] | undefined;
    expect(teardownArgs?.at(-1)).toContain("Teardown command failed");
    expect(fakeDb.tables.pipeline_item[0]).toMatchObject({
      id: "task-source",
      stage: "in progress",
    });
    expect(fakeDb.tables.pipeline_item[0]?.teardown_started_at).not.toBeNull();
    expect(fakeDb.tables.pipeline_item[0]?.closed_at).toBeNull();
  });
});
