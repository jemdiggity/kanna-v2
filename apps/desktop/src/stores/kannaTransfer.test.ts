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
  updateDesktopServerClientHandlersForTests,
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

const toastMock = vi.hoisted(() => ({
  toasts: { value: [] },
  dismiss: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../composables/useToast", () => ({
  useToast: () => toastMock,
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
    cloud_task_id: "cloud-task-source",
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
    target_desktop_id: null,
    task: {
      cloud_task_id: "cloud-task-source",
      source_peer_id: "peer-source",
      source_desktop_id: null,
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
    if (cmd === "mark_incoming_transfer_ack_completed") {
      try {
        return await handler(cmd, args);
      } catch (error) {
        if (error instanceof Error && error.message === `unexpected invoke: ${cmd}`) {
          return null;
        }
        throw error;
      }
    }
    return handler(cmd, args);
  });
}

/** Mirrors the store's pre-creation destination task id derivation. */
async function destinationTaskIdForTransfer(transferId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`kanna-transfer-destination:${transferId}`),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
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

  const findActiveOutgoingTransfer = (sourceTaskId: string | null | undefined) =>
    sourceTaskId == null
      ? undefined
      : tables.task_transfer.find((row) =>
        row.direction === "outgoing"
        && row.source_task_id === sourceTaskId
        && ["pending", "streaming"].includes(String(row.status)));

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
    fetchRepoKannaDefinitions: async () => ({
      revision: "remote-rev",
      refName: "origin/main",
      config: {},
      defaultPipeline: "default",
      pipelines: ["default"],
    }),
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
    putTaskAgentSession: async (taskId, agentSessionId) => {
      const item = tables.pipeline_item.find((candidate) => candidate.id === taskId);
      if (item) {
        item.agent_session_id = agentSessionId;
      }
    },
    setTaskCloudIdentity: async (taskId, cloudTaskId) => {
      const item = tables.pipeline_item.find((candidate) => candidate.id === taskId);
      if (!item) throw new Error(`task not found: ${taskId}`);
      item.cloud_task_id = cloudTaskId;
    },
    claimTaskPorts: async (taskId) => ({ taskId, portEnv: {}, firstPort: null }),
    releaseTaskPorts: async () => {},
    closeTask: async (taskId) => {
      const item = tables.pipeline_item.find((candidate) => candidate.id === taskId);
      if (item) {
        const repo = tables.repo.find((candidate) => candidate.id === item.repo_id);
        if (repo && item.branch) {
          const worktreePath = `${repo.path}/.kanna-worktrees/${item.branch}`;
          try {
            const rawConfig = await invokeMock("read_text_file", {
              path: `${worktreePath}/.kanna/config.json`,
            });
            const parsed = JSON.parse(String(rawConfig || "{}")) as { teardown?: string[] };
            if (parsed.teardown && parsed.teardown.length > 0) {
              item.teardown_started_at = new Date().toISOString();
              await invokeMock("spawn_session", {
                sessionId: `td-${taskId}`,
                cwd: worktreePath,
                executable: "/bin/zsh",
                args: [
                  "--login",
                  "-i",
                  "-c",
                  `printf '\\033[33mRunning teardown...\\033[0m\\n' && ${parsed.teardown[0]} || printf '\\nTeardown command failed\\n'`,
                ],
                env: {
                  KANNA_WORKTREE: "1",
                  KANNA_TMUX_SESSION: "",
                  KANNA_DB_NAME: "",
                  KANNA_DB_PATH: "",
                  KANNA_DAEMON_DIR: "",
                  KANNA_TRANSFER_ROOT: "",
                  KANNA_WEBDRIVER_PORT: "",
                  KANNA_E2E_TARGET_WEBDRIVER_PORT: "",
                },
                cols: 120,
                rows: 30,
              });
              await invokeMock("attach_session_with_snapshot", { sessionId: `td-${taskId}` });
              return;
            }
          } catch {
            // No repo teardown config in this test fixture.
          }
        }
        item.closed_at = new Date().toISOString();
        item.updated_at = item.closed_at;
      }
    },
    createTask: async (request) => {
      const repo = tables.repo.find((candidate) => candidate.id === request.repoId);
      if (!repo) throw new Error(`repo not found: ${request.repoId}`);
      const id = `task-${tables.pipeline_item.length + 1}`;
      const item = buildItem(repo.id);
      item.id = id;
      item.prompt = request.prompt;
      item.branch = `task-${id}`;
      item.display_name = request.displayName ?? null;
      item.pipeline = request.pipelineName ?? "default";
      item.stage = request.stage ?? "in progress";
      item.agent_type = request.agentType ?? "pty";
      item.agent_provider = (request.agentProvider ?? "claude") as PipelineItem["agent_provider"];
      item.base_ref = request.baseRef ?? null;
      item.agent_session_id = request.resumeSessionId ?? null;
      tables.pipeline_item.push(item);
      const resumeFlag = request.resumeSessionId
        ? item.agent_provider === "copilot"
          ? `--resume='${request.resumeSessionId}'`
          : item.agent_provider === "codex"
            ? `codex resume '${request.resumeSessionId}'`
          : `--resume ${request.resumeSessionId}`
        : request.prompt;
      const spawnArgs: Record<string, unknown> = {
        sessionId: id,
        agentProvider: item.agent_provider,
        args: [resumeFlag],
      };
      if (item.agent_provider === "codex") {
        spawnArgs.env = {
          PATH: "/Applications/Kanna.app/Contents/MacOS:/usr/local/bin:/usr/bin:/bin",
        };
      }
      await invokeMock("spawn_session", spawnArgs).catch(() => undefined);
      return {
        taskId: id,
        repoId: repo.id,
        title: request.displayName ?? request.prompt,
        stage: item.stage,
        agentType: item.agent_type ?? "pty",
        worktreePath: `${repo.path}/.kanna-worktrees/${item.branch}`,
      };
    },
    findRepoByPath: async (path: string) =>
      tables.repo.find((repo) => repo.path === path) as never ?? null,
    addRepo: async ({ path, name, defaultBranch }) => {
      const existing = tables.repo.find((repo) => repo.path === path);
      if (existing) return existing as never;
      const repo = {
        ...buildRepo(),
        id: `repo-${tables.repo.length + 1}`,
        path,
        name: name ?? path.split("/").pop() ?? "repo",
        default_branch: defaultBranch ?? "",
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
      // Mirrors `idx_task_transfer_active_outgoing_source` from migration 036.
      if (transfer.direction === "outgoing" && findActiveOutgoingTransfer(transfer.source_task_id)) {
        throw new Error("UNIQUE constraint failed: task_transfer.source_task_id");
      }
      tables.task_transfer.push({
        ...transfer,
        started_at: new Date().toISOString(),
        completed_at: null,
      });
    },
    getTaskTransfer: async (transferId: string) =>
      tables.task_transfer.find((transfer) => transfer.id === transferId) as never ?? null,
    fetchActiveOutgoingTaskTransfer: async (sourceTaskId: string) =>
      findActiveOutgoingTransfer(sourceTaskId) as never ?? null,
    updateTaskTransferPayload: async (transferId: string, payloadJson: string) => {
      const row = tables.task_transfer.find((transfer) => transfer.id === transferId);
      if (!row) return false;
      row.payload_json = payloadJson;
      row.error = null;
      return true;
    },
    markTaskTransferImporting: async (transferId: string, localTaskId: string) => {
      const row = tables.task_transfer.find((transfer) => transfer.id === transferId);
      if (!row) return false;
      row.status = "importing";
      row.local_task_id = localTaskId;
      row.error = null;
      return true;
    },
    markTaskTransferAwaitingAcknowledgment: async (transferId: string, localTaskId: string) => {
      const row = tables.task_transfer.find((transfer) => transfer.id === transferId);
      if (!row || row.local_task_id !== localTaskId) return false;
      row.status = "awaiting_acknowledgment";
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
    failOutgoingTaskTransfer: async (transferId: string, reason: string) => {
      const row = tables.task_transfer.find((transfer) => transfer.id === transferId);
      if (
        !row
        || row.direction !== "outgoing"
        || ["completed", "rejected", "failed"].includes(String(row.status))
      ) {
        return false;
      }
      row.status = "failed";
      row.completed_at = new Date().toISOString();
      row.error = reason;
      return true;
    },
    markIncomingTransferSidecarCleanupCompleted: async (transferId: string) => {
      const row = tables.task_transfer.find((transfer) => transfer.id === transferId);
      if (!row || !["completed", "rejected", "failed"].includes(String(row.status))) {
        return false;
      }
      row.sidecar_cleanup_completed_at ??= new Date().toISOString();
      return true;
    },
    insertTaskTransferProvenance: async (provenance: NewTaskTransferProvenanceInput) => {
      if (!tables.task_transfer_provenance.some(
        (row) => row.pipeline_item_id === provenance.pipeline_item_id,
      )) {
        tables.task_transfer_provenance.push(provenance);
      }
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

    createTransferDb({});
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

  it("marks unavailable source desktop identity as safe to retry before preflight", async () => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    createTransferDb({});
    store.repos = [buildRepo()];
    store.items = [buildItem()];
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "mobile_server_status") return {};
      return null;
    });

    const error = await store.pushTaskToPeer("task-source", "peer-target", {
      transport: "cloud",
      targetDesktopId: "desktop-target",
    }).catch((caught) => caught);

    expect(error).toMatchObject({
      message: "source desktop identity is unavailable for cloud transfer",
      retryableTaskPush: true,
    });
    expect(invokeMock).not.toHaveBeenCalledWith("prepare_outgoing_transfer", expect.anything());
  });

  it("falls back from LAN connection failure to cloud before creating the transfer row", async () => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const fakeDb = createTransferDb({});
    await store.init(fakeDb);
    store.repos = [buildRepo()];
    store.items = [buildItem()];
    loadSessionRecoveryStateMock.mockResolvedValue(null);
    let preflightCount = 0;

    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd === "mobile_server_status") return { desktopId: "desktop-source" };
      if (cmd === "prepare_outgoing_transfer") {
        const payload = args?.payload as Record<string, unknown>;
        if (payload.phase === "preflight") {
          preflightCount += 1;
          if (payload.transport === "lan") {
            throw new Error("i/o error: Connection refused");
          }
          return {
            transferId: "transfer-cloud",
            sourcePeerId: "peer-source",
            targetHasRepo: true,
          };
        }
        return { ok: true };
      }
      return null;
    });

    await store.pushTaskToPeer("task-source", "peer-target", {
      transport: "lan",
      cloudFallback: true,
      targetDesktopId: "desktop-target",
    });

    expect(preflightCount).toBe(2);
    const prepareCalls = invokeMock.mock.calls.filter(
      ([command]) => command === "prepare_outgoing_transfer",
    );
    expect(prepareCalls[0]).toEqual(["prepare_outgoing_transfer", {
      payload: {
        phase: "preflight",
        sourceTaskId: "task-source",
        targetPeerId: "peer-target",
        transport: "lan",
      },
    }]);
    expect(prepareCalls[1]).toEqual(["prepare_outgoing_transfer", {
      payload: {
        phase: "preflight",
        sourceTaskId: "task-source",
        targetPeerId: "peer-target",
        transport: "cloud",
      },
    }]);
    expect(fakeDb.tables.task_transfer).toHaveLength(1);
    expect(fakeDb.tables.task_transfer[0]).toMatchObject({
      source_desktop_id: "desktop-source",
      target_desktop_id: "desktop-target",
    });
    const payload = JSON.parse(fakeDb.tables.task_transfer[0]!.payload_json!);
    expect(payload.task.source_desktop_id).toBe("desktop-source");
    expect(payload.target_desktop_id).toBe("desktop-target");
  });

  it("does not cloud-retry protocol failures or failures after preflight", async () => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const fakeDb = createTransferDb({});
    await store.init(fakeDb);
    store.repos = [buildRepo()];
    store.items = [buildItem()];
    loadSessionRecoveryStateMock.mockResolvedValue(null);

    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "mobile_server_status") return { desktopId: "desktop-source" };
      if (cmd === "prepare_outgoing_transfer") {
        throw new Error("protocol error: peer key mismatch");
      }
      return null;
    });
    await expect(store.pushTaskToPeer("task-source", "peer-target", {
      transport: "lan",
      cloudFallback: true,
      targetDesktopId: "desktop-target",
    })).rejects.toThrow("key mismatch");
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "prepare_outgoing_transfer")).toHaveLength(1);
    expect(fakeDb.tables.task_transfer).toHaveLength(0);

    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd === "mobile_server_status") return { desktopId: "desktop-source" };
      if (cmd === "prepare_outgoing_transfer") {
        const payload = args?.payload as Record<string, unknown>;
        if (payload.phase === "preflight") {
          return {
            transferId: "transfer-commit",
            sourcePeerId: "peer-source",
            targetHasRepo: true,
          };
        }
        throw new Error("i/o error: connection reset during commit");
      }
      return null;
    });
    await expect(store.pushTaskToPeer("task-source", "peer-target", {
      transport: "lan",
      cloudFallback: true,
      targetDesktopId: "desktop-target",
    })).rejects.toThrow("during commit");
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "prepare_outgoing_transfer")).toHaveLength(2);
    expect(fakeDb.tables.task_transfer).toHaveLength(1);

    // The row the failed commit left behind is still the task's active
    // outgoing transfer, so a further push has nothing to do — and saying so by
    // throwing would make the pull requester treat it as a dropped delivery.
    await expect(store.pushTaskToPeer("task-source", "peer-target", {
      transport: "lan",
      cloudFallback: true,
      targetDesktopId: "desktop-target",
    })).resolves.toBeUndefined();
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "prepare_outgoing_transfer")).toHaveLength(2);
    expect(fakeDb.tables.task_transfer).toHaveLength(1);
  });

  /**
   * The renderer's in-memory push guards die with the app; the row does not.
   * A fresh store — the app-restart case — has to reach the same answer.
   */
  it("skips a push for a task the DB already has an outgoing transfer for", async () => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const fakeDb = createTransferDb({
      transfers: [{
        id: "transfer-existing",
        direction: "outgoing",
        status: "pending",
        source_task_id: "task-source",
        local_task_id: "task-source",
      }],
    });
    await store.init(fakeDb);
    store.repos = [buildRepo()];
    // The snapshot has not caught up with the row, so only the DB read can
    // stop this push.
    store.items = [buildItem()];
    invokeMock.mockImplementation(async () => null);

    await expect(store.pushTaskToPeer("task-source", "peer-target")).resolves.toBeUndefined();

    expect(invokeMock).not.toHaveBeenCalledWith("prepare_outgoing_transfer", expect.anything());
    expect(fakeDb.tables.task_transfer).toHaveLength(1);
  });

  /**
   * The 2026-08-06 incident: two `task-pull-requested` deliveries raced past a
   * stale snapshot, the loser's insert hit
   * `idx_task_transfer_active_outgoing_source`, and the raw 500 left its
   * preflight reservation on disk.
   */
  it("keeps two racing pushes to one transfer row and releases the loser's reservation", async () => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const fakeDb = createTransferDb({});
    await store.init(fakeDb);
    store.repos = [buildRepo()];
    store.items = [buildItem()];
    loadSessionRecoveryStateMock.mockResolvedValue(null);
    toastMock.warning.mockClear();

    let preflights = 0;
    const abandoned: string[] = [];
    let releasePreflight!: () => void;
    const bothPreflightsIssued = new Promise<void>((resolve) => { releasePreflight = resolve; });
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd === "abandon_outgoing_transfer") {
        abandoned.push(String(args?.transferId));
        return { transferId: args?.transferId };
      }
      if (cmd === "prepare_outgoing_transfer") {
        const payload = args?.payload as Record<string, unknown>;
        if (payload.phase !== "preflight") return { ok: true };
        preflights += 1;
        const reservation = preflights;
        // Hold both pushes past their DB eligibility read so they race the
        // insert, exactly as the two deliveries did. Each still gets its own
        // reservation, as the target peer would mint.
        if (preflights === 2) releasePreflight();
        await bothPreflightsIssued;
        return {
          transferId: `transfer-race-${reservation}`,
          sourcePeerId: "peer-source",
          targetHasRepo: true,
        };
      }
      return null;
    });

    // Both deliveries clear the snapshot and in-flight guards before either
    // reaches the DB, which is exactly how the incident's second push got
    // started.
    await expect(Promise.all([
      store.pushTaskToPeer("task-source", "peer-target"),
      store.pushTaskToPeer("task-source", "peer-target"),
    ])).resolves.toEqual([undefined, undefined]);

    expect(preflights).toBe(2);
    expect(fakeDb.tables.task_transfer).toHaveLength(1);
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]).not.toBe(fakeDb.tables.task_transfer[0]!.id);
    expect(toastMock.warning).not.toHaveBeenCalled();
  });

  /**
   * A reservation that could not be released really is orphaned on disk, and
   * only the operator can clear it — so this one is said out loud rather than
   * logged and forgotten.
   */
  it("surfaces a duplicate reservation it could not release", async () => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const fakeDb = createTransferDb({
      transfers: [{
        id: "transfer-winner",
        direction: "outgoing",
        status: "pending",
        source_task_id: "task-source",
        local_task_id: "task-source",
      }],
    });
    await store.init(fakeDb);
    store.repos = [buildRepo()];
    store.items = [buildItem()];
    loadSessionRecoveryStateMock.mockResolvedValue(null);
    toastMock.warning.mockClear();

    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd === "abandon_outgoing_transfer") {
        throw new Error("transfer sidecar is not running");
      }
      if (cmd === "prepare_outgoing_transfer") {
        const payload = args?.payload as Record<string, unknown>;
        if (payload.phase !== "preflight") return { ok: true };
        return {
          transferId: "transfer-loser",
          sourcePeerId: "peer-source",
          targetHasRepo: true,
        };
      }
      return null;
    });

    // The DB pre-check would normally stop this push; skipping straight to the
    // insert is what a push that lost the race after its own read looks like.
    updateDesktopServerClientHandlersForTests({
      fetchActiveOutgoingTaskTransfer: async () => null,
    });

    await expect(store.pushTaskToPeer("task-source", "peer-target")).resolves.toBeUndefined();

    expect(fakeDb.tables.task_transfer).toHaveLength(1);
    expect(toastMock.warning).toHaveBeenCalledTimes(1);
    expect(toastMock.warning.mock.calls[0]?.[0]).toContain("transfer-loser");
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
      source_desktop_id: null,
      target_desktop_id: null,
      source_task_id: "task-source",
      local_task_id: "task-source",
      payload_json: expect.any(String),
    });
  });

  it("refuses to push a resumable session it cannot ship rather than committing an artifact-less payload", async () => {
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

    await expect(store.pushTaskToPeer("task-source", "peer-target")).rejects.toThrow(
      /carries no|could not be found/,
    );

    // `artifacts: []` beside a valid resume id is the exact payload that lost a
    // conversation in the field; it must never reach the commit phase.
    const prepareCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "prepare_outgoing_transfer");
    expect(prepareCalls).toHaveLength(1);
    expect(prepareCalls[0]?.[1]).toMatchObject({ payload: { phase: "preflight" } });
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
      owned: false,
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
      if (cmd === "locate_claude_transcript") {
        return {
          absolutePath:
            "/Users/tester/.claude/projects/-tmp-repo-1--kanna-worktrees-task-task-source/364643cc-5e6d-48fc-86ca-ca7764380900.jsonl",
          homeRelPath:
            ".claude/projects/-tmp-repo-1--kanna-worktrees-task-task-source/364643cc-5e6d-48fc-86ca-ca7764380900.jsonl",
          filename: "364643cc-5e6d-48fc-86ca-ca7764380900.jsonl",
        };
      }
      if (cmd === "stage_transfer_artifact") {
        return { transferId: "transfer-123", artifactId: args?.artifactId };
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
      owned: true,
    });

    const prepareCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "prepare_outgoing_transfer");
    expect(prepareCalls[1]?.[1]).toMatchObject({
      payload: {
        phase: "commit",
        transferId: "transfer-123",
        payload: {
          artifacts: expect.arrayContaining([
            expect.objectContaining({
              artifact_id: "transfer-123-claude-session",
              provider: "claude",
              kind: "session-archive",
              materialization: "extract-tar-gz",
              home_rel_path: ".claude/tasks/364643cc-5e6d-48fc-86ca-ca7764380900",
            }),
          ]),
        },
      },
    });
  });

  it("ships the claude conversation transcript alongside the session archive", async () => {
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
      if (cmd === "read_env_var") return "/Users/tester";
      // The `~/.claude/tasks/<id>` directory is absent, which is exactly the
      // shape that used to ship an empty artifact list beside a valid resume id.
      if (cmd === "file_exists") return false;
      if (cmd === "locate_claude_transcript") {
        return {
          absolutePath:
            "/Users/tester/.claude/projects/-tmp-repo-1--kanna-worktrees-task-task-source/364643cc-5e6d-48fc-86ca-ca7764380900.jsonl",
          homeRelPath:
            ".claude/projects/-tmp-repo-1--kanna-worktrees-task-task-source/364643cc-5e6d-48fc-86ca-ca7764380900.jsonl",
          filename: "364643cc-5e6d-48fc-86ca-ca7764380900.jsonl",
        };
      }
      if (cmd === "stage_transfer_artifact") {
        return { transferId: "transfer-123", artifactId: args?.artifactId };
      }
      return null;
    });

    await expect(store.pushTaskToPeer("task-source", "peer-target")).resolves.toBeUndefined();

    expect(invokeMock).toHaveBeenCalledWith("locate_claude_transcript", {
      worktreePath: "/tmp/repo-1/.kanna-worktrees/task-task-source",
      sessionId: "364643cc-5e6d-48fc-86ca-ca7764380900",
    });
    expect(invokeMock).toHaveBeenCalledWith("stage_transfer_artifact", {
      transferId: "transfer-123",
      artifactId: "transfer-123-claude-transcript",
      path:
        "/Users/tester/.claude/projects/-tmp-repo-1--kanna-worktrees-task-task-source/364643cc-5e6d-48fc-86ca-ca7764380900.jsonl",
      owned: false,
    });

    const prepareCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "prepare_outgoing_transfer");
    expect(prepareCalls[1]?.[1]).toMatchObject({
      payload: {
        phase: "commit",
        transferId: "transfer-123",
        payload: {
          artifacts: [{
            artifact_id: "transfer-123-claude-transcript",
            filename: "364643cc-5e6d-48fc-86ca-ca7764380900.jsonl",
            provider: "claude",
            kind: "session-transcript",
            materialization: "copy-file",
            home_rel_path:
              ".claude/projects/-tmp-repo-1--kanna-worktrees-task-task-source/364643cc-5e6d-48fc-86ca-ca7764380900.jsonl",
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
      owned: true,
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
      owned: true,
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
      source_desktop_id: null,
      target_desktop_id: null,
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

  it.each([
    ["repository acquisition completion", 0],
    ["artifact materialization completion", 0],
    ["task creation completion", 1],
  ])("fences stale import ownership after %s", async (lostPhase, expectedTasks) => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const payload = {
      ...buildIncomingTransferPayload(),
      task: {
        ...buildIncomingTransferPayload().task,
        resume_session_id: "resume-fenced",
      },
      artifacts: [{
        artifact_id: "artifact-fenced",
        filename: "claude-session.tar.gz",
        provider: "claude" as const,
        kind: "session-archive" as const,
        materialization: "extract-tar-gz" as const,
        home_rel_path: ".claude/tasks/resume-fenced",
      }],
    };
    const fakeDb = createTransferDb({
      transfers: [{
        id: "transfer-1",
        direction: "incoming",
        status: "claimed",
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
      if (cmd === "file_exists") return (args?.path as string) === "/tmp/repo-1";
      if (cmd === "fetch_transfer_artifact") return { path: "/tmp/session.tar.gz" };
      if (cmd === "materialize_transfer_artifact") return true;
      if (cmd === "which_binary") return args?.name === "claude" ? "/usr/bin/claude" : null;
      if (cmd === "git_worktree_add" || cmd === "spawn_agent_session") return null;
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    await expect(store.approveIncomingTransfer(
      "transfer-1",
      "owner-stale",
      {
        assertOwnership: async (phase) => phase !== lostPhase,
      },
    )).rejects.toThrow(/ownership was lost/);

    expect(fakeDb.tables.pipeline_item).toHaveLength(expectedTasks);
    expect(fakeDb.tables.task_transfer[0]?.status).not.toBe("completed");
    expect(fakeDb.tables.task_transfer_provenance).toHaveLength(0);
    expect(invokeMock).not.toHaveBeenCalledWith(
      "acknowledge_incoming_transfer_commit",
      expect.anything(),
    );
  });

  it("rejects finalized payload provenance that differs from the durable reservation", async () => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const payload = buildIncomingTransferPayload();
    payload.task.source_peer_id = "peer-impersonated";
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
    mockIncomingTransferApprovalInvoke(payload, async (cmd) => {
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    await expect(store.approveIncomingTransfer("transfer-1")).rejects.toThrow(
      /source identity does not match reservation/i,
    );
    expect(fakeDb.tables.pipeline_item).toHaveLength(0);
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
      if (cmd === "acknowledge_incoming_transfer_commit") return null;
      if (cmd === "mark_incoming_transfer_ack_completed") return null;
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
      if (cmd === "acknowledge_incoming_transfer_commit") return null;
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
      cloud_task_id: "cloud-task-source",
    });
    expect(fakeDb.tables.task_transfer[0]).toMatchObject({
      id: "transfer-1",
      status: "completed",
      local_task_id: localTaskId,
      error: null,
      sidecar_cleanup_completed_at: expect.any(String),
    });
    expect(fakeDb.tables.task_transfer_provenance[0]).toMatchObject({
      pipeline_item_id: localTaskId,
      source_peer_id: "peer-source",
      source_task_id: "task-source",
      source_machine_task_label: "task-source",
    });
  });

  it("sets stable cloud identity before completing and acknowledging the import", async () => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const payload = {
      ...buildIncomingTransferPayload(),
      task: {
        ...buildIncomingTransferPayload().task,
        cloud_task_id: "cloud-stable",
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

    const events: string[] = [];
    updateDesktopServerClientHandlersForTests({
      setTaskCloudIdentity: async (taskId, cloudTaskId) => {
        events.push(`identity:${taskId}:${cloudTaskId}`);
      },
      completeTaskTransfer: async (transferId, localTaskId) => {
        events.push(`complete:${transferId}:${localTaskId}`);
        return true;
      },
      markIncomingTransferSidecarCleanupCompleted: async (transferId) => {
        events.push(`cleanup-recorded:${transferId}`);
        return true;
      },
    });
    mockIncomingTransferApprovalInvoke(payload, async (cmd, args) => {
      if (cmd === "file_exists") return (args?.path as string) === "/tmp/repo-1";
      if (cmd === "which_binary") return args?.name === "claude" ? "/usr/bin/claude" : null;
      if (cmd === "git_worktree_add" || cmd === "spawn_agent_session") return null;
      if (cmd === "acknowledge_incoming_transfer_commit") {
        events.push(`ack:${args?.transferId as string}`);
        return null;
      }
      if (cmd === "mark_incoming_transfer_ack_completed") {
        events.push(`mark:${args?.transferId as string}`);
        return null;
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    const destinationTaskId = await store.approveIncomingTransfer("transfer-1");

    expect(events).toEqual([
      `identity:${destinationTaskId}:cloud-stable`,
      "ack:transfer-1",
      `complete:transfer-1:${destinationTaskId}`,
      "mark:transfer-1",
      "cleanup-recorded:transfer-1",
    ]);
  });

  it("does not complete or acknowledge when stable identity persistence fails", async () => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const payload = {
      ...buildIncomingTransferPayload(),
      task: {
        ...buildIncomingTransferPayload().task,
        cloud_task_id: "cloud-stable",
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

    const completeTaskTransfer = vi.fn(async () => true);
    updateDesktopServerClientHandlersForTests({
      setTaskCloudIdentity: async () => {
        throw new Error("identity write failed");
      },
      completeTaskTransfer,
    });
    mockIncomingTransferApprovalInvoke(payload, async (cmd, args) => {
      if (cmd === "file_exists") return (args?.path as string) === "/tmp/repo-1";
      if (cmd === "which_binary") return args?.name === "claude" ? "/usr/bin/claude" : null;
      if (cmd === "git_worktree_add" || cmd === "spawn_agent_session") return null;
      if (cmd === "acknowledge_incoming_transfer_commit") {
        throw new Error("acknowledgment must not run");
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    await expect(store.approveIncomingTransfer("transfer-1")).rejects.toThrow("identity write failed");
    expect(completeTaskTransfer).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith(
      "acknowledge_incoming_transfer_commit",
      expect.anything(),
    );
  });

  it("reuses a durably claimed local task when the identity write applies then throws", async () => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const payload = {
      ...buildIncomingTransferPayload(),
      task: {
        ...buildIncomingTransferPayload().task,
        cloud_task_id: "cloud-stable",
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

    let identityCalls = 0;
    updateDesktopServerClientHandlersForTests({
      setTaskCloudIdentity: async (taskId, cloudTaskId) => {
        identityCalls += 1;
        const item = fakeDb.tables.pipeline_item.find((candidate) => candidate.id === taskId);
        if (!item) throw new Error(`task not found: ${taskId}`);
        item.cloud_task_id = cloudTaskId;
        if (identityCalls === 1) throw new Error("identity response lost");
      },
    });
    const acknowledge = vi.fn(async () => null);
    mockIncomingTransferApprovalInvoke(payload, async (cmd, args) => {
      if (cmd === "file_exists") return (args?.path as string) === "/tmp/repo-1";
      if (cmd === "which_binary") return args?.name === "claude" ? "/usr/bin/claude" : null;
      if (cmd === "git_worktree_add" || cmd === "spawn_agent_session") return null;
      if (cmd === "acknowledge_incoming_transfer_commit") return acknowledge();
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    await expect(store.approveIncomingTransfer("transfer-1")).rejects.toThrow("identity response lost");
    const claimedTaskId = fakeDb.tables.task_transfer[0]?.local_task_id;
    expect(claimedTaskId).toBeTruthy();
    expect(fakeDb.tables.task_transfer[0]?.status).toBe("importing");
    expect(fakeDb.tables.pipeline_item).toHaveLength(1);

    await expect(store.approveIncomingTransfer("transfer-1")).resolves.toBe(claimedTaskId);
    expect(fakeDb.tables.pipeline_item).toHaveLength(1);
    expect(fakeDb.tables.task_transfer_provenance).toHaveLength(1);
    expect(fakeDb.tables.task_transfer[0]?.status).toBe("completed");
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });

  it("retains awaiting acknowledgment for retry and completes only after acknowledgment succeeds", async () => {
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

    let acknowledgmentCalls = 0;
    mockIncomingTransferApprovalInvoke(payload, async (cmd, args) => {
      if (cmd === "file_exists") return (args?.path as string) === "/tmp/repo-1";
      if (cmd === "which_binary") return args?.name === "claude" ? "/usr/bin/claude" : null;
      if (cmd === "git_worktree_add" || cmd === "spawn_agent_session") return null;
      if (cmd === "acknowledge_incoming_transfer_commit") {
        acknowledgmentCalls += 1;
        if (acknowledgmentCalls === 1) throw new Error("source unavailable");
        return null;
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    await expect(store.approveIncomingTransfer("transfer-1")).rejects.toThrow("source unavailable");
    const claimedTaskId = fakeDb.tables.task_transfer[0]?.local_task_id;
    expect(fakeDb.tables.task_transfer[0]?.status).toBe("awaiting_acknowledgment");
    expect(fakeDb.tables.pipeline_item).toHaveLength(1);

    await expect(store.approveIncomingTransfer("transfer-1")).resolves.toBe(claimedTaskId);
    expect(fakeDb.tables.pipeline_item).toHaveLength(1);
    expect(fakeDb.tables.task_transfer[0]?.status).toBe("completed");
    expect(acknowledgmentCalls).toBe(2);
  });

  it("repairs a destination crash after task prepare before acknowledging the source", async () => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const payload = buildIncomingTransferPayload();
    const fakeDb = createTransferDb({
      transfers: [{
        id: "transfer-1",
        direction: "incoming",
        status: "streaming",
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

    let uniqueWorktrees = 0;
    let uniqueSessions = 0;
    let firstResponseLost = true;
    updateDesktopServerClientHandlersForTests({
      createTask: async (request) => {
        const requestedTaskId = (request as typeof request & { requestedTaskId?: string })
          .requestedTaskId;
        if (!requestedTaskId) throw new Error("incoming create did not request a stable task id");
        const existing = fakeDb.tables.pipeline_item.find((item) => item.id === requestedTaskId);
        if (existing) {
          if (uniqueSessions === 0) uniqueSessions += 1;
          return {
            taskId: existing.id,
            repoId: existing.repo_id,
            title: existing.display_name ?? existing.prompt ?? "",
            stage: existing.stage,
            agentType: existing.agent_type ?? "pty",
            worktreePath: `/tmp/repo-1/.kanna-worktrees/${existing.branch}`,
          };
        }
        const item = buildItem(request.repoId);
        item.id = requestedTaskId;
        item.prompt = request.prompt;
        item.branch = `task-${requestedTaskId}`;
        item.display_name = request.displayName ?? null;
        item.cloud_task_id = null;
        fakeDb.tables.pipeline_item.push(item);
        uniqueWorktrees += 1;
        if (firstResponseLost) {
          firstResponseLost = false;
          throw new Error("create response lost");
        }
        return {
          taskId: item.id,
          repoId: item.repo_id,
          title: item.display_name ?? item.prompt ?? "",
          stage: item.stage,
          agentType: item.agent_type ?? "pty",
          worktreePath: `/tmp/repo-1/.kanna-worktrees/${item.branch}`,
        };
      },
    });
    mockIncomingTransferApprovalInvoke(payload, async (cmd, args) => {
      if (cmd === "file_exists") return (args?.path as string) === "/tmp/repo-1";
      if (cmd === "which_binary") return args?.name === "claude" ? "/usr/bin/claude" : null;
      if (cmd === "git_worktree_add" || cmd === "spawn_agent_session") return null;
      if (cmd === "acknowledge_incoming_transfer_commit") {
        expect(uniqueSessions).toBe(1);
        return null;
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    await expect(store.approveIncomingTransfer("transfer-1")).rejects.toThrow("create response lost");
    await expect(store.approveIncomingTransfer("transfer-1")).resolves.toMatch(/^[0-9a-f]{64}$/);

    expect(fakeDb.tables.pipeline_item).toHaveLength(1);
    expect(uniqueWorktrees).toBe(1);
    expect(uniqueSessions).toBe(1);
    expect(fakeDb.tables.task_transfer[0]?.local_task_id).toBe(
      fakeDb.tables.pipeline_item[0]?.id,
    );
  });

  it("concurrent approvals converge on one deterministic destination task", async () => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const payload = buildIncomingTransferPayload();
    const fakeDb = createTransferDb({
      transfers: [{
        id: "transfer-concurrent",
        direction: "incoming",
        status: "streaming",
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

    let uniqueWorktrees = 0;
    let uniqueSessions = 0;
    updateDesktopServerClientHandlersForTests({
      createTask: async (request) => {
        const requestedTaskId = (request as typeof request & { requestedTaskId?: string })
          .requestedTaskId;
        if (!requestedTaskId) throw new Error("incoming create did not request a stable task id");
        let item = fakeDb.tables.pipeline_item.find((candidate) => candidate.id === requestedTaskId);
        if (!item) {
          item = buildItem(request.repoId);
          item.id = requestedTaskId;
          item.prompt = request.prompt;
          item.branch = `task-${requestedTaskId}`;
          item.cloud_task_id = null;
          fakeDb.tables.pipeline_item.push(item);
          uniqueWorktrees += 1;
          uniqueSessions += 1;
        }
        return {
          taskId: item.id,
          repoId: item.repo_id,
          title: item.display_name ?? item.prompt ?? "",
          stage: item.stage,
          agentType: item.agent_type ?? "pty",
          worktreePath: `/tmp/repo-1/.kanna-worktrees/${item.branch}`,
        };
      },
    });
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd === "finalize_outgoing_transfer") {
        return {
          transferId: "transfer-concurrent",
          payload,
          finalizedCleanly: true,
        };
      }
      if (cmd === "git_default_branch") return "main";
      if (cmd === "git_list_base_branches") return ["origin/main", "main"];
      if (cmd === "git_fetch") return null;
      if (cmd === "file_exists") return (args?.path as string) === "/tmp/repo-1";
      if (cmd === "which_binary") return args?.name === "claude" ? "/usr/bin/claude" : null;
      if (cmd === "git_worktree_add" || cmd === "spawn_agent_session") return null;
      if (cmd === "acknowledge_incoming_transfer_commit") return null;
      if (cmd === "mark_incoming_transfer_ack_completed") return null;
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    const [first, second] = await Promise.all([
      store.approveIncomingTransfer("transfer-concurrent"),
      store.approveIncomingTransfer("transfer-concurrent"),
    ]);

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(fakeDb.tables.pipeline_item).toHaveLength(1);
    expect(uniqueWorktrees).toBe(1);
    expect(uniqueSessions).toBe(1);
    expect(fakeDb.tables.task_transfer[0]?.local_task_id).toBe(first);
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
      if (cmd === "acknowledge_incoming_transfer_commit") return null;
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    const localTaskId = await store.approveIncomingTransfer("transfer-1");
    await flushBackgroundSetup();

    expect(invokeMock).toHaveBeenCalledWith("git_clone", {
      url: "git@github.com:jemdiggity/kanna.git",
      destination: "/Users/test/.kanna/repos/repo-1",
    });
    expect(fakeDb.tables.repo[0]?.default_branch).toBe("main");
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
      if (cmd === "acknowledge_incoming_transfer_commit") return null;
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
      if (cmd === "acknowledge_incoming_transfer_commit") return null;
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

  it.each([true, false])(
    "restores codex resume state when artifact publication returns %s",
    async (materialized) => {
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
      if (cmd === "materialize_transfer_artifact") {
        return materialized;
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
      agent_session_id: "019d9a8c-9f39-7240-818f-88367a7c31df",
    });
    expect(invokeMock).not.toHaveBeenCalledWith("seed_session_recovery_state", expect.anything());
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
    },
  );

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
      if (cmd === "materialize_transfer_artifact") {
        return true;
      }
      if (cmd === "acknowledge_incoming_transfer_commit") {
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
    expect(invokeMock).toHaveBeenCalledWith("materialize_transfer_artifact", {
      sourcePath: "/tmp/fetched-rollout.jsonl",
      provider: "codex",
      resumeSessionId: "019d9a8c-9f39-7240-818f-88367a7c31df",
      filename: "rollout-2026-04-18T06-27-04-019d9a8c-9f39-7240-818f-88367a7c31df.jsonl",
      kind: "session-rollout",
      materialization: "copy-file",
    });
    expect(invokeMock).not.toHaveBeenCalledWith("copy_file", expect.anything());
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

  // A payload that promises a resumable session and ships no way to resume it
  // used to mint a fresh one, silently discarding the conversation the source
  // machine had already given up. Refusing is the only honest answer: the
  // source still holds the only copy.
  it.each([
    {
      provider: "claude" as const,
      resumeSessionId: "364643cc-5e6d-48fc-86ca-ca7764380900",
      missingKind: "session-transcript",
      binary: "claude",
    },
    {
      provider: "copilot" as const,
      resumeSessionId: "5fc2bd17-1d1b-4ae9-bed8-011fa4011100",
      missingKind: "session-archive",
      binary: "copilot",
    },
    {
      provider: "codex" as const,
      resumeSessionId: "019d9a8c-9f39-7240-818f-88367a7c31df",
      missingKind: "session-rollout",
      binary: "codex",
    },
  ])("refuses a $provider import that resumes a session it cannot restore", async ({
    provider,
    resumeSessionId,
    missingKind,
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

    await expect(store.approveIncomingTransfer("transfer-1")).rejects.toThrow(
      `carries no ${missingKind} artifact`,
    );
    await flushBackgroundSetup();

    // No destination task at all — a fresh session here is the data loss.
    expect(fakeDb.tables.pipeline_item).toHaveLength(0);
    expect(invokeMock).not.toHaveBeenCalledWith("spawn_session", expect.anything());
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
    payload.artifacts = [
      {
        artifact_id: "artifact-claude-session",
        filename: "claude-session.tar.gz",
        provider: "claude",
        kind: "session-archive",
        materialization: "extract-tar-gz",
        home_rel_path: ".claude/tasks/364643cc-5e6d-48fc-86ca-ca7764380900",
      },
      // The transcript is what makes the resume legal at all; the archive rides
      // along for its highwatermark.
      {
        artifact_id: "artifact-claude-transcript",
        filename: "364643cc-5e6d-48fc-86ca-ca7764380900.jsonl",
        provider: "claude",
        kind: "session-transcript",
        materialization: "copy-file",
        home_rel_path:
          ".claude/projects/-tmp-repo-1--kanna-worktrees-task-task-source/364643cc-5e6d-48fc-86ca-ca7764380900.jsonl",
      },
    ];
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
          artifactId: args?.artifactId,
          path: args?.artifactId === "artifact-claude-transcript"
            ? "/tmp/fetched-claude-transcript.jsonl"
            : "/tmp/fetched-claude-session.tar.gz",
        };
      }
      if (cmd === "read_env_var") {
        return "/Users/tester";
      }
      if (cmd === "materialize_transfer_artifact") {
        return true;
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

    expect(localTaskId).toEqual(expect.any(String));
    expect(invokeMock).toHaveBeenCalledWith("materialize_transfer_artifact", {
      sourcePath: "/tmp/fetched-claude-session.tar.gz",
      provider: "claude",
      resumeSessionId: "364643cc-5e6d-48fc-86ca-ca7764380900",
      filename: "claude-session.tar.gz",
      kind: "session-archive",
      materialization: "extract-tar-gz",
    });
    expect(invokeMock).not.toHaveBeenCalledWith("run_script", expect.objectContaining({
      script: expect.stringContaining("/tmp/fetched-claude-session.tar.gz"),
    }));
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

  it("re-keys a transferred claude transcript to the destination worktree before resuming", async () => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const sessionId = "364643cc-5e6d-48fc-86ca-ca7764380900";
    const payload = buildIncomingTransferPayload() as ReturnType<typeof buildIncomingTransferPayload> & {
      artifacts?: Array<Record<string, unknown>>;
    };
    payload.task.agent_provider = "claude";
    payload.task.agent_type = "pty";
    payload.task.resume_session_id = sessionId;
    payload.artifacts = [
      {
        artifact_id: "artifact-claude-session",
        filename: "claude-session.tar.gz",
        provider: "claude",
        kind: "session-archive",
        materialization: "extract-tar-gz",
        home_rel_path: `.claude/tasks/${sessionId}`,
      },
      {
        artifact_id: "artifact-claude-transcript",
        filename: `${sessionId}.jsonl`,
        provider: "claude",
        kind: "session-transcript",
        materialization: "copy-file",
        home_rel_path: `.claude/projects/-tmp-repo-1--kanna-worktrees-task-task-source/${sessionId}.jsonl`,
      },
    ];
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
      if (cmd === "file_exists") return (args?.path as string) === "/tmp/repo-1";
      if (cmd === "read_text_file") return "";
      if (cmd === "read_builtin_resource") throw new Error("missing builtin resource");
      if (cmd === "git_default_branch") return "main";
      if (cmd === "which_binary") return args?.name === "claude" ? "/usr/bin/claude" : null;
      if (cmd === "get_app_data_dir") return "/tmp/kanna-mock-data";
      if (cmd === "get_pipeline_socket_path") return "/tmp/kanna.sock";
      if (cmd === "read_env_var") return "/Users/tester";
      if (cmd === "fetch_transfer_artifact") {
        return {
          transferId: "transfer-1",
          artifactId: args?.artifactId,
          path: `/tmp/fetched-${args?.artifactId as string}`,
        };
      }
      if (cmd === "materialize_transfer_artifact") {
        // A pre-existing `~/.claude/tasks/<id>` lock directory must not veto a
        // resume whose conversation transcript landed.
        return args?.kind !== "session-archive";
      }
      if (cmd === "git_worktree_add" || cmd === "acknowledge_incoming_transfer_commit") return null;
      if (cmd === "spawn_session") return null;
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    const localTaskId = await store.approveIncomingTransfer("transfer-1");
    await flushBackgroundSetup();

    // The destination task id is derived from the transfer id alone, so the
    // worktree — and therefore the transcript's slug — is known before the task
    // exists.
    const destinationTaskId = await destinationTaskIdForTransfer("transfer-1");
    expect(invokeMock).toHaveBeenCalledWith("materialize_transfer_artifact", {
      sourcePath: "/tmp/fetched-artifact-claude-transcript",
      provider: "claude",
      resumeSessionId: sessionId,
      filename: `${sessionId}.jsonl`,
      kind: "session-transcript",
      materialization: "copy-file",
      destinationWorktreePath: `/tmp/repo-1/.kanna-worktrees/task-${destinationTaskId}`,
    });
    // The archive keeps the sender-independent contract: no destination path.
    expect(invokeMock).toHaveBeenCalledWith("materialize_transfer_artifact", {
      sourcePath: "/tmp/fetched-artifact-claude-session",
      provider: "claude",
      resumeSessionId: sessionId,
      filename: "claude-session.tar.gz",
      kind: "session-archive",
      materialization: "extract-tar-gz",
    });
    expect(invokeMock).toHaveBeenCalledWith(
      "spawn_session",
      expect.objectContaining({
        sessionId: localTaskId,
        agentProvider: "claude",
        args: expect.arrayContaining([
          expect.stringContaining(`--resume ${sessionId}`),
        ]),
      }),
    );
  });

  it("tells the receiving operator when the source could not be shut down cleanly", async () => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const payload = buildIncomingTransferPayload() as ReturnType<typeof buildIncomingTransferPayload> & {
      finalization?: Record<string, unknown>;
    };
    payload.finalization = {
      cleanly_finalized: false,
      degraded_reason: "the source agent session could not be signalled to finish",
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
    toastMock.warning.mockClear();

    mockIncomingTransferApprovalInvoke(payload, async (cmd, args) => {
      if (cmd === "file_exists") return (args?.path as string) === "/tmp/repo-1";
      if (cmd === "read_text_file") return "";
      if (cmd === "read_builtin_resource") throw new Error("missing builtin resource");
      if (cmd === "git_default_branch") return "main";
      if (cmd === "which_binary") return args?.name === "claude" ? "/usr/bin/claude" : null;
      if (cmd === "get_app_data_dir") return "/tmp/kanna-mock-data";
      if (cmd === "get_pipeline_socket_path") return "/tmp/kanna.sock";
      if (cmd === "git_worktree_add" || cmd === "acknowledge_incoming_transfer_commit") return null;
      if (cmd === "spawn_session") return null;
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    // The task still arrives — a degraded handoff is not a failed one — but the
    // operator who now owns it is told, on this machine too.
    await expect(store.approveIncomingTransfer("transfer-1")).resolves.toEqual(expect.any(String));
    await flushBackgroundSetup();

    expect(toastMock.warning).toHaveBeenCalledWith(
      expect.stringContaining("could not be signalled to finish"),
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
      if (cmd === "materialize_transfer_artifact") {
        return true;
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

    expect(localTaskId).toEqual(expect.any(String));
    expect(invokeMock).toHaveBeenCalledWith("materialize_transfer_artifact", {
      sourcePath: "/tmp/fetched-copilot-session.tar.gz",
      provider: "copilot",
      resumeSessionId: "5fc2bd17-1d1b-4ae9-bed8-011fa4011100",
      filename: "copilot-session.tar.gz",
      kind: "session-archive",
      materialization: "extract-tar-gz",
    });
    expect(invokeMock).not.toHaveBeenCalledWith("run_script", expect.objectContaining({
      script: expect.stringContaining("/tmp/fetched-copilot-session.tar.gz"),
    }));
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

  // A destination that already holds the provider's session-state directory is
  // a legitimate skip, not a failure — nothing was lost, the state is simply
  // already here. Claude is deliberately absent: its conversation lives in the
  // transcript, so a pre-existing lock directory must not veto a resume.
  it.each([
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
      if (cmd === "materialize_transfer_artifact") {
        return false;
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

    expect(localTaskId).toEqual(expect.any(String));
    expect(invokeMock).toHaveBeenCalledWith("fetch_transfer_artifact", {
      transferId: "transfer-1",
      artifactId,
    });
    expect(invokeMock).toHaveBeenCalledWith(
      "materialize_transfer_artifact",
      expect.objectContaining({
        sourcePath: artifactPath,
        provider,
        resumeSessionId,
      }),
    );
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
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "mark_incoming_transfer_ack_completed") {
        expect(args).toEqual({ transferId: "transfer-1" });
        expect(fakeDb.tables.task_transfer[0]?.status).toBe("rejected");
        return null;
      }
      throw new Error(`unexpected invoke: ${command}`);
    });
    await store.rejectIncomingTransfer("transfer-1");

    expect(fakeDb.tables.task_transfer[0]).toMatchObject({
      id: "transfer-1",
      status: "rejected",
      error: "Rejected locally",
      sidecar_cleanup_completed_at: expect.any(String),
    });
    expect(invokeMock).toHaveBeenCalledWith("mark_incoming_transfer_ack_completed", {
      transferId: "transfer-1",
    });
  });

  it("cleans every repeatedly rejected incoming reservation", async () => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const fakeDb = createTransferDb({
      transfers: ["transfer-1", "transfer-2"].map((id) => ({
        id,
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
      })),
    });
    invokeMock.mockResolvedValue(null);

    await store.init(fakeDb);
    await store.rejectIncomingTransfer("transfer-1");
    await store.rejectIncomingTransfer("transfer-2");

    expect(invokeMock).toHaveBeenNthCalledWith(
      1,
      "mark_incoming_transfer_ack_completed",
      { transferId: "transfer-1" },
    );
    expect(invokeMock).toHaveBeenNthCalledWith(
      2,
      "mark_incoming_transfer_ack_completed",
      { transferId: "transfer-2" },
    );
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

    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd === "read_env_var") return "/Users/tester";
      if (cmd === "file_exists") return true;
      if (cmd === "list_dir") {
        const path = args?.path;
        if (path === "/Users/tester/.codex/sessions") return ["2026"];
        if (path === "/Users/tester/.codex/sessions/2026") return ["04"];
        if (path === "/Users/tester/.codex/sessions/2026/04") return ["18"];
        if (path === "/Users/tester/.codex/sessions/2026/04/18") {
          return ["rollout-2026-04-18T06-27-04-019d-initial.jsonl"];
        }
        return [];
      }
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
    expect(result.payload.task.source_task_id).toBe("task-source");
    // The session never exited inside the wait, so the handoff is degraded —
    // recorded on the payload the receiver reads, not just logged here.
    expect(result.finalizedCleanly).toBe(false);
    expect(result.payload.finalization).toEqual({
      cleanly_finalized: false,
      degraded_reason: "the source agent session did not exit within 1500ms",
    });
  });

  it("fails the transfer and leaves the source session running when the conversation cannot be staged", async () => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const sourceItem = buildItem();
    sourceItem.agent_session_id = "364643cc-5e6d-48fc-86ca-ca7764380900";
    const outgoingPayload = buildOutgoingTransferPayload({
      sourcePeerId: "peer-source",
      sourceTaskId: sourceItem.id,
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
        id: "transfer-no-transcript",
        direction: "outgoing",
        status: "pending",
        source_peer_id: "peer-source",
        target_peer_id: "peer-target",
        source_task_id: sourceItem.id,
        local_task_id: sourceItem.id,
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
      if (cmd === "read_env_var") return "/Users/tester";
      if (cmd === "file_exists") return true;
      // No transcript for this worktree — the shape that shipped `artifacts: []`
      // beside a valid resume id and lost 2.1 MB of conversation.
      if (cmd === "locate_claude_transcript") return null;
      return null;
    });

    // The refusal lands before any wait: nothing has been signalled yet.
    await expect(store.finalizeOutgoingTransfer("transfer-no-transcript"))
      .rejects.toThrow("no transcript exists");

    const row = fakeDb.tables.task_transfer[0];
    expect(row).toMatchObject({ status: "failed" });
    expect(String(row?.error)).toContain("no transcript exists");
    // The payload on the row is the pre-finalization one: an artifact-less
    // finalized payload must never be persisted.
    expect(JSON.parse(String(row?.payload_json)).artifacts).toEqual([]);
    // The source agent was never signalled, so its task is intact and running.
    expect(invokeMock).not.toHaveBeenCalledWith("signal_session", expect.anything());
    expect(fakeDb.tables.pipeline_item[0]?.closed_at).toBeNull();
  });

  it("records a refused finalization signal as a degradation instead of swallowing it", async () => {
    vi.useFakeTimers();

    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const sourceItem = buildItem();
    sourceItem.agent_session_id = null;
    const outgoingPayload = buildOutgoingTransferPayload({
      sourcePeerId: "peer-source",
      sourceTaskId: sourceItem.id,
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
        id: "transfer-adopted",
        direction: "outgoing",
        status: "pending",
        source_peer_id: "peer-source",
        target_peer_id: "peer-target",
        source_task_id: sourceItem.id,
        local_task_id: sourceItem.id,
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

    // What the daemon does for every session it adopted through a handoff —
    // i.e. every task older than the running daemon, so every task that
    // survived an app upgrade.
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "signal_session") {
        throw new Error("cannot signal adopted session");
      }
      return null;
    });

    const finalizePromise = store.finalizeOutgoingTransfer("transfer-adopted");
    await vi.advanceTimersByTimeAsync(1500);
    const result = await finalizePromise;

    // Degraded, not failed: the transcript is appended continuously, so the
    // conversation still crosses. Blocking here would block every transfer
    // after an app upgrade.
    expect(result.finalizedCleanly).toBe(false);
    expect(result.payload.finalization.cleanly_finalized).toBe(false);
    expect(result.payload.finalization.degraded_reason).toContain(
      "could not be signalled to finish",
    );
    expect(result.payload.finalization.degraded_reason).toContain("adopted session");
  });

  it("stops finalization before snapshot persistence after delivery ownership is lost", async () => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const sourceItem = buildItem();
    sourceItem.agent_session_id = "claude-session-owner-lost";
    const outgoingPayload = buildOutgoingTransferPayload({
      sourcePeerId: "peer-source",
      sourceTaskId: sourceItem.id,
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
        id: "transfer-owner-lost",
        direction: "outgoing",
        status: "pending",
        source_peer_id: "peer-source",
        target_peer_id: "peer-target",
        source_task_id: sourceItem.id,
        local_task_id: sourceItem.id,
        started_at: new Date().toISOString(),
        completed_at: null,
        error: null,
        payload_json: JSON.stringify(outgoingPayload),
      }],
    });
    const updatePayload = vi.fn(async () => true);
    updateDesktopServerClientHandlersForTests({
      updateTaskTransferPayload: updatePayload,
    });
    await store.init(fakeDb);
    store.repos = [buildRepo()];
    store.items = [sourceItem];
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "read_env_var") return "/Users/tester";
      if (cmd === "file_exists") return true;
      if (cmd === "locate_claude_transcript") {
        return {
          absolutePath:
            "/Users/tester/.claude/projects/-tmp-repo-1--kanna-worktrees-task-task-source/claude-session-owner-lost.jsonl",
          homeRelPath:
            ".claude/projects/-tmp-repo-1--kanna-worktrees-task-task-source/claude-session-owner-lost.jsonl",
          filename: "claude-session-owner-lost.jsonl",
        };
      }
      return null;
    });

    const assertOwnership = vi.fn(async (phase: string) => {
      if (phase === "Claude archive staging") {
        throw new Error("lifecycle delivery ownership was lost before archive staging");
      }
    });
    const claimPhase = vi.fn(async () => true);
    const finalizePromise = store.finalizeOutgoingTransfer("transfer-owner-lost", {
      deliveryId: "lifecycle-finalization-lost",
      assertOwnership,
      claimPhase,
    });
    const rejection = expect(finalizePromise).rejects.toThrow("ownership was lost");
    await vi.advanceTimersByTimeAsync(1500);

    await rejection;
    expect(invokeMock).toHaveBeenCalledWith("signal_session", {
      sessionId: sourceItem.id,
      signal: "SIGINT",
    });
    expect(claimPhase).toHaveBeenCalledWith("pty-finalization-signal");
    expect(invokeMock).toHaveBeenCalledWith("remove_file", {
      path: "/tmp/kanna-transfer-transfer-owner-lost-claude-session-lifecycle-finalization-lost.tar.gz",
    });
    expect(invokeMock).not.toHaveBeenCalledWith(
      "stage_transfer_artifact",
      expect.anything(),
    );
    expect(updatePayload).not.toHaveBeenCalled();
  });

  it("preserves authenticated desktop identities while rebuilding the finalized payload", async () => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const sourceItem = buildItem();
    const payload = buildOutgoingTransferPayload({
      sourcePeerId: "peer-source",
      sourceDesktopId: "desktop-source",
      sourceTaskId: sourceItem.id,
      targetPeerId: "peer-target",
      targetDesktopId: "desktop-target",
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
        source_desktop_id: "desktop-source",
        target_desktop_id: "desktop-target",
        source_task_id: sourceItem.id,
        local_task_id: sourceItem.id,
        started_at: new Date().toISOString(),
        completed_at: null,
        error: null,
        payload_json: JSON.stringify(payload),
      }],
    });
    await store.init(fakeDb);
    store.repos = [buildRepo()];
    store.items = [sourceItem];
    loadSessionRecoveryStateMock.mockResolvedValue(null);
    invokeMock.mockResolvedValue(null);

    const finalizePromise = store.finalizeOutgoingTransfer("transfer-123");
    await vi.advanceTimersByTimeAsync(1500);
    const result = await finalizePromise;

    expect(result.payload.task.source_desktop_id).toBe("desktop-source");
    expect(result.payload.target_desktop_id).toBe("desktop-target");
  });
});

describe("outgoing transfer commit acknowledgment", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    loadSessionRecoveryStateMock.mockReset();
  });

  it("tombstones a replay whose completed transfer row was already compacted", async () => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    await store.init(createTransferDb({}));
    invokeMock.mockResolvedValue(null);

    await store.handleOutgoingTransferCommitted({
      transferId: "transfer-compacted",
      sourceTaskId: "task-source",
      destinationLocalTaskId: "task-imported",
    });

    expect(invokeMock).toHaveBeenCalledWith("mark_outgoing_transfer_commit_applied", {
      transferId: "transfer-compacted",
    });
  });

  it("does not complete a transfer when delivery ownership is lost during source closure", async () => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const repo = buildRepo();
    const sourceItem = buildItem(repo.id);
    const fakeDb = createTransferDb({
      repos: [repo],
      items: [sourceItem],
      transfers: [{
        id: "transfer-owner-lost",
        direction: "outgoing",
        status: "pending",
        source_peer_id: "peer-source",
        target_peer_id: "peer-target",
        source_task_id: sourceItem.id,
        local_task_id: sourceItem.id,
        started_at: new Date().toISOString(),
        completed_at: null,
        error: null,
        payload_json: JSON.stringify(buildIncomingTransferPayload()),
      }],
    });
    const completeTransfer = vi.fn(async () => true);
    updateDesktopServerClientHandlersForTests({
      completeTaskTransfer: completeTransfer,
    });
    await store.init(fakeDb);
    store.repos = [repo];
    store.items = [sourceItem];
    invokeMock.mockResolvedValue(null);
    const assertOwnership = vi.fn(async (phase: string) => {
      if (phase === "outgoing transfer completion") {
        throw new Error("lifecycle delivery ownership was lost before completion");
      }
    });

    await expect(store.handleOutgoingTransferCommitted({
      transferId: "transfer-owner-lost",
      sourceTaskId: sourceItem.id,
      destinationLocalTaskId: "task-imported",
    }, {
      deliveryId: "lifecycle-commit-lost",
      assertOwnership,
    })).rejects.toThrow("ownership was lost");

    expect(fakeDb.tables.pipeline_item[0]?.closed_at).not.toBeNull();
    expect(completeTransfer).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith(
      "mark_outgoing_transfer_commit_applied",
      expect.anything(),
    );
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
      if (cmd === "mark_outgoing_transfer_commit_applied") return null;
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

  it("finishes source closure and receipt application when a completed row is replayed", async () => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const repo = buildRepo();
    const sourceItem = buildItem(repo.id);
    const fakeDb = createTransferDb({
      repos: [repo],
      items: [sourceItem],
      transfers: [{
        id: "transfer-replay",
        direction: "outgoing",
        status: "completed",
        source_peer_id: "peer-source",
        target_peer_id: "peer-target",
        source_task_id: sourceItem.id,
        local_task_id: sourceItem.id,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        error: null,
        payload_json: JSON.stringify(buildIncomingTransferPayload()),
      }],
    });
    await store.init(fakeDb);
    store.repos = [repo];
    store.items = [sourceItem];

    const events: string[] = [];
    updateDesktopServerClientHandlersForTests({
      closeTask: async (taskId) => {
        events.push(`close:${taskId}`);
        const item = fakeDb.tables.pipeline_item.find((candidate) => candidate.id === taskId);
        if (item) item.closed_at = new Date().toISOString();
      },
      completeTaskTransfer: async (transferId) => {
        events.push(`complete:${transferId}`);
        return true;
      },
      fetchClosedTaskIdentities: async () => fakeDb.tables.pipeline_item
        .filter((item) => item.closed_at !== null)
        .map((item) => ({ id: item.id, repo_id: item.repo_id })),
    });
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd === "mark_outgoing_transfer_commit_applied") {
        events.push(`applied:${args?.transferId as string}`);
        return null;
      }
      if (cmd === "set_transfer_task_snapshot") return null;
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    await store.handleOutgoingTransferCommitted({
      transferId: "transfer-replay",
      sourceTaskId: sourceItem.id,
      destinationLocalTaskId: "task-destination",
    });

    expect(events).toEqual([
      `close:${sourceItem.id}`,
      "complete:transfer-replay",
      "applied:transfer-replay",
    ]);
    expect(fakeDb.tables.pipeline_item[0]?.closed_at).not.toBeNull();
  });

  it("replays the remaining suffix after completion succeeds but receipt application fails", async () => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const repo = buildRepo();
    const sourceItem = buildItem(repo.id);
    const fakeDb = createTransferDb({
      repos: [repo],
      items: [sourceItem],
      transfers: [{
        id: "transfer-crash",
        direction: "outgoing",
        status: "pending",
        source_peer_id: "peer-source",
        target_peer_id: "peer-target",
        source_task_id: sourceItem.id,
        local_task_id: sourceItem.id,
        started_at: new Date().toISOString(),
        completed_at: null,
        error: null,
        payload_json: JSON.stringify(buildIncomingTransferPayload()),
      }],
    });
    await store.init(fakeDb);
    store.repos = [repo];
    store.items = [sourceItem];

    const events: string[] = [];
    updateDesktopServerClientHandlersForTests({
      closeTask: async (taskId) => {
        events.push(`close:${taskId}`);
        const item = fakeDb.tables.pipeline_item.find((candidate) => candidate.id === taskId);
        if (item) item.closed_at = new Date().toISOString();
      },
      completeTaskTransfer: async (transferId, localTaskId) => {
        events.push(`complete:${transferId}`);
        const row = fakeDb.tables.task_transfer.find((candidate) => candidate.id === transferId);
        if (row) {
          row.status = "completed";
          row.local_task_id = localTaskId;
          row.completed_at = new Date().toISOString();
        }
        return true;
      },
      fetchClosedTaskIdentities: async () => fakeDb.tables.pipeline_item
        .filter((item) => item.closed_at !== null)
        .map((item) => ({ id: item.id, repo_id: item.repo_id })),
    });
    let appliedCalls = 0;
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd === "mark_outgoing_transfer_commit_applied") {
        appliedCalls += 1;
        events.push(`applied:${args?.transferId as string}`);
        if (appliedCalls === 1) throw new Error("receipt response lost");
        return null;
      }
      if (cmd === "set_transfer_task_snapshot") return null;
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    const event = {
      transferId: "transfer-crash",
      sourceTaskId: sourceItem.id,
      destinationLocalTaskId: "task-destination",
    };
    await expect(store.handleOutgoingTransferCommitted(event)).rejects.toThrow(
      "receipt response lost",
    );
    await expect(store.handleOutgoingTransferCommitted(event)).resolves.toBeUndefined();

    expect(events).toEqual([
      `close:${sourceItem.id}`,
      "complete:transfer-crash",
      "applied:transfer-crash",
      "complete:transfer-crash",
      "applied:transfer-crash",
    ]);
    expect(fakeDb.tables.task_transfer[0]?.status).toBe("completed");
    expect(fakeDb.tables.pipeline_item[0]?.closed_at).not.toBeNull();
  });

  it("replays completion after source closure succeeds and completion initially fails", async () => {
    setActivePinia(createPinia());
    const { useKannaStore } = await import("./kanna");
    const store = useKannaStore();
    const repo = buildRepo();
    const sourceItem = buildItem(repo.id);
    const fakeDb = createTransferDb({
      repos: [repo],
      items: [sourceItem],
      transfers: [{
        id: "transfer-close-crash",
        direction: "outgoing",
        status: "pending",
        source_peer_id: "peer-source",
        target_peer_id: "peer-target",
        source_task_id: sourceItem.id,
        local_task_id: sourceItem.id,
        started_at: new Date().toISOString(),
        completed_at: null,
        error: null,
        payload_json: JSON.stringify(buildIncomingTransferPayload()),
      }],
    });
    await store.init(fakeDb);
    store.repos = [repo];
    store.items = [sourceItem];

    const events: string[] = [];
    updateDesktopServerClientHandlersForTests({
      closeTask: async (taskId) => {
        events.push(`close:${taskId}`);
        const item = fakeDb.tables.pipeline_item.find((candidate) => candidate.id === taskId);
        if (item) item.closed_at = new Date().toISOString();
      },
      completeTaskTransfer: async (transferId, localTaskId) => {
        events.push(`complete:${transferId}`);
        if (events.filter((event) => event === `complete:${transferId}`).length === 1) {
          throw new Error("completion unavailable");
        }
        const row = fakeDb.tables.task_transfer.find((candidate) => candidate.id === transferId);
        if (row) {
          row.status = "completed";
          row.local_task_id = localTaskId;
          row.completed_at = new Date().toISOString();
        }
        return true;
      },
      fetchClosedTaskIdentities: async () => fakeDb.tables.pipeline_item
        .filter((item) => item.closed_at !== null)
        .map((item) => ({ id: item.id, repo_id: item.repo_id })),
    });
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd === "mark_outgoing_transfer_commit_applied") {
        events.push(`applied:${args?.transferId as string}`);
        return null;
      }
      if (cmd === "set_transfer_task_snapshot") return null;
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    const event = {
      transferId: "transfer-close-crash",
      sourceTaskId: sourceItem.id,
      destinationLocalTaskId: "task-destination",
    };
    await expect(store.handleOutgoingTransferCommitted(event)).rejects.toThrow(
      "completion unavailable",
    );
    await expect(store.handleOutgoingTransferCommitted(event)).resolves.toBeUndefined();

    expect(events).toEqual([
      `close:${sourceItem.id}`,
      "complete:transfer-close-crash",
      "complete:transfer-close-crash",
      "applied:transfer-close-crash",
    ]);
    expect(fakeDb.tables.task_transfer[0]?.status).toBe("completed");
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
      if (cmd === "mark_outgoing_transfer_commit_applied") return null;
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
