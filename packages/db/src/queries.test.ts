import { describe, it, expect, beforeEach } from "vitest";
import {
  listRepos,
  getRepo,
  insertRepo,
  deleteRepo,
  hideRepo,
  unhideRepo,
  updateRepoName,
  updateRepoRemoteMetadata,
  findRepoByPath,
  listPipelineItems,
  listTaskPorts,
  listTaskPortsForItem,
  deleteTaskPortsForItem,
  insertWorktree,
  upsertTerminalSession,
  insertPipelineItem,
  insertTaskBlocker,
  hasCircularDependency,
  updatePipelineItemStage,
  markPipelineItemTearingDown,
  updatePipelineItemTags,
  updatePipelineItemStageResult,
  clearPipelineItemStageResult,
  updatePipelineItemActivePostAction,
  clearPipelineItemActivePostAction,
  updatePipelineItemPR,
  updatePipelineItemActivity,
  getSetting,
  setSetting,
  updatePipelineItemParent,
  pinPipelineItem,
  unpinPipelineItem,
  reorderPinnedItems,
  reorderRepos,
  insertTrustedPeer,
  listTrustedPeers,
  revokeTrustedPeer,
  insertTaskTransfer,
  listTaskTransfersForItem,
  getTaskTransfer,
  markTaskTransferCompleted,
  markTaskTransferRejected,
  insertTaskTransferProvenance,
  getTaskTransferProvenance,
  insertOperatorEvent,
  insertStageRun,
  listStageRunsForTask,
  finishStageRun,
  type DbHandle,
} from "./queries.js";
import type {
  Repo,
  PipelineItem,
  Setting,
  OperatorEvent,
  TaskBlocker,
  TaskPort,
  TerminalSession,
  TrustedPeer,
  TaskTransfer,
  TaskTransferProvenance,
  StageRun,
  Worktree,
} from "./schema.js";

// ---------------------------------------------------------------------------
// In-memory DbHandle for testing
// ---------------------------------------------------------------------------

function createMockDb(): DbHandle & {
  tables: {
    repo: Repo[];
    pipeline_item: PipelineItem[];
    task_blocker: TaskBlocker[];
    task_port: TaskPort[];
    terminal_session: TerminalSession[];
    worktree: Worktree[];
    trusted_peer: TrustedPeer[];
    task_transfer: TaskTransfer[];
    task_transfer_provenance: TaskTransferProvenance[];
    stage_run: StageRun[];
    settings: Setting[];
    operator_event: Omit<OperatorEvent, "id" | "created_at">[];
  };
  setNow: (isoTimestamp: string) => void;
} {
  let nowIso = "2026-01-01T00:00:00.000Z";
  const currentTimestamp = () => nowIso;
  const tables = {
    repo: [] as Repo[],
    pipeline_item: [] as PipelineItem[],
    task_blocker: [] as TaskBlocker[],
    task_port: [] as TaskPort[],
    terminal_session: [] as TerminalSession[],
    worktree: [] as Worktree[],
    trusted_peer: [] as TrustedPeer[],
    task_transfer: [] as TaskTransfer[],
    task_transfer_provenance: [] as TaskTransferProvenance[],
    stage_run: [] as StageRun[],
    settings: [] as Setting[],
    operator_event: [] as Omit<OperatorEvent, "id" | "created_at">[],
  };

  return {
    tables,
    setNow(isoTimestamp: string) {
      nowIso = isoTimestamp;
    },
    async execute(query: string, bindValues?: unknown[]) {
      const q = query.trim().toUpperCase();

      if (q.startsWith("INSERT INTO REPO")) {
        const [id, path, name, default_branch, remote_url, remote_url_hash] = bindValues as (string | null)[];
        tables.repo.push({
          id: id!,
          path: path!,
          name: name!,
          default_branch: default_branch!,
          remote_url,
          remote_url_hash,
          hidden: 0,
          sort_order: tables.repo.length,
          created_at: currentTimestamp(),
          last_opened_at: currentTimestamp(),
        });
      } else if (q.startsWith("DELETE FROM REPO")) {
        const [id] = bindValues as string[];
        tables.repo = tables.repo.filter((r) => r.id !== id);
      } else if (q.startsWith("UPDATE REPO SET HIDDEN = 1")) {
        const [id] = bindValues as [string];
        const repo = tables.repo.find((r) => r.id === id);
        if (repo) repo.hidden = 1;
      } else if (q.startsWith("UPDATE REPO SET HIDDEN = 0")) {
        const [id] = bindValues as [string];
        const repo = tables.repo.find((r) => r.id === id);
        if (repo) repo.hidden = 0;
      } else if (q.startsWith("UPDATE REPO SET SORT_ORDER")) {
        const [sortOrder, id] = bindValues as [number, string];
        const repo = tables.repo.find((r) => r.id === id);
        if (repo) repo.sort_order = sortOrder;
      } else if (q.startsWith("UPDATE REPO SET NAME")) {
        const [name, id] = bindValues as [string, string];
        const repo = tables.repo.find((r) => r.id === id);
        if (repo) repo.name = name;
      } else if (q.startsWith("UPDATE REPO SET REMOTE_URL")) {
        const [remoteUrl, remoteUrlHash, id] = bindValues as [string | null, string | null, string];
        const repo = tables.repo.find((r) => r.id === id);
        if (repo) {
          repo.remote_url = remoteUrl;
          repo.remote_url_hash = remoteUrlHash;
        }
      } else if (q.startsWith("INSERT INTO PIPELINE_ITEM")) {
        const [id, repo_id, issue_number, issue_title, prompt, pipeline, pipeline_def, stage, tagsJson, pr_number, pr_url, branch, agent_type, agent_provider, port_offset, port_env, agent_spawn_options, activity] =
          bindValues as unknown[];
        tables.pipeline_item.push({
          id: id as string,
          repo_id: repo_id as string,
          issue_number: (issue_number as number | null),
          issue_title: (issue_title as string | null),
          prompt: (prompt as string | null),
          pipeline: (pipeline as string) || "default",
          pipeline_def: (pipeline_def as string | null) ?? null,
          stage: (stage as string) || "in progress",
          stage_result: null,
          active_post_action: null,
          tags: (tagsJson as string) || "[]",
          pr_number: (pr_number as number | null),
          pr_url: (pr_url as string | null),
          branch: (branch as string | null),
          agent_type: (agent_type as string | null),
          agent_provider: agent_provider as PipelineItem["agent_provider"],
          port_offset: (port_offset as number | null) ?? null,
          port_env: (port_env as string | null) ?? null,
          agent_spawn_options: (agent_spawn_options as string | null) ?? null,
          activity: (activity as string) || "idle",
          activity_changed_at: currentTimestamp(),
          unread_at: null,
          closed_at: null,
          display_name: null,
          last_output_preview: null,
          base_ref: null,
          agent_session_id: null,
          previous_stage: null,
          teardown_started_at: null,
          parent_task_id: (bindValues?.[20] as string | null) ?? null,
          created_at: currentTimestamp(),
          updated_at: currentTimestamp(),
          pinned: 0,
          pin_order: null,
        } as PipelineItem);
      } else if (q.startsWith("INSERT INTO STAGE_RUN")) {
        const [id, task_id, stage, agent, agent_provider, model, status, result, feedback, session_id] =
          bindValues as [
            string,
            string,
            string,
            string | null,
            StageRun["agent_provider"],
            string | null,
            StageRun["status"],
            string | null,
            string | null,
            string | null,
          ];
        tables.stage_run.push({
          id,
          task_id,
          stage,
          agent,
          agent_provider,
          model,
          status,
          result,
          feedback,
          session_id,
          started_at: currentTimestamp(),
          finished_at: null,
        });
      } else if (q.startsWith("INSERT OR IGNORE INTO TASK_BLOCKER")) {
        const [blocked_item_id, blocker_item_id] = bindValues as [string, string];
        const existing = tables.task_blocker.find(
          (row) => row.blocked_item_id === blocked_item_id && row.blocker_item_id === blocker_item_id,
        );
        if (!existing) {
          tables.task_blocker.push({ blocked_item_id, blocker_item_id });
        }
      } else if (q.startsWith("INSERT OR IGNORE INTO TASK_PORT")) {
        const [port, pipeline_item_id, env_name] = bindValues as [number, string, string];
        const existing = tables.task_port.find((p) => p.port === port);
        if (!existing) {
          tables.task_port.push({
            port,
            pipeline_item_id,
            env_name,
            created_at: new Date().toISOString(),
          });
        }
      } else if (q.startsWith("INSERT INTO WORKTREE")) {
        const [id, pipeline_item_id, path, branch] = bindValues as [string, string, string, string];
        const existing = tables.worktree.find((row) => row.id === id);
        if (existing) {
          existing.pipeline_item_id = pipeline_item_id;
          existing.path = path;
          existing.branch = branch;
        } else {
          tables.worktree.push({
            id,
            pipeline_item_id,
            path,
            branch,
            created_at: new Date().toISOString(),
          });
        }
      } else if (q.startsWith("INSERT INTO TERMINAL_SESSION")) {
        const [id, repo_id, pipeline_item_id, label, cwd, daemon_session_id] = bindValues as [
          string,
          string,
          string | null,
          string | null,
          string | null,
          string | null,
        ];
        const existing = tables.terminal_session.find((row) => row.id === id);
        if (existing) {
          existing.repo_id = repo_id;
          existing.pipeline_item_id = pipeline_item_id;
          existing.label = label;
          existing.cwd = cwd;
          existing.daemon_session_id = daemon_session_id;
        } else {
          tables.terminal_session.push({
            id,
            repo_id,
            pipeline_item_id,
            label,
            cwd,
            daemon_session_id,
            created_at: new Date().toISOString(),
          });
        }
      } else if (q.startsWith("INSERT INTO TRUSTED_PEER")) {
        const [id, peer_id, display_name, public_key, capabilities_json] = bindValues as [
          string,
          string,
          string,
          string,
          string,
        ];
        tables.trusted_peer.push({
          id,
          peer_id,
          display_name,
          public_key,
          capabilities_json,
          paired_at: new Date().toISOString(),
          last_seen_at: null,
          revoked_at: null,
        });
      } else if (q.startsWith("UPDATE TRUSTED_PEER SET REVOKED_AT")) {
        const [peerId] = bindValues as [string];
        const peer = tables.trusted_peer.find((row) => row.peer_id === peerId);
        if (peer) peer.revoked_at = new Date().toISOString();
      } else if (q.startsWith("INSERT INTO TASK_TRANSFER_PROVENANCE")) {
        const [pipeline_item_id, source_peer_id, source_task_id, source_machine_task_label] = bindValues as [
          string,
          string,
          string,
          string | null,
        ];
        tables.task_transfer_provenance.push({
          pipeline_item_id,
          source_peer_id,
          source_task_id,
          source_machine_task_label,
          imported_at: new Date().toISOString(),
        });
      } else if (q.startsWith("INSERT INTO TASK_TRANSFER")) {
        const [id, direction, status, source_peer_id, target_peer_id, source_task_id, local_task_id, error, payload_json] =
          bindValues as [
            string,
            TaskTransfer["direction"],
            TaskTransfer["status"],
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
          source_peer_id,
          target_peer_id,
          source_task_id,
          local_task_id,
          started_at: new Date().toISOString(),
          completed_at: status === "completed" || status === "failed" ? new Date().toISOString() : null,
          error,
          payload_json,
        });
      } else if (q.startsWith("UPDATE TASK_TRANSFER")) {
        const [firstValue, secondValue] = bindValues as [string, string];
        const transfer = tables.task_transfer.find((row) => row.id === secondValue);
        if (transfer && q.includes("STATUS = 'COMPLETED'")) {
          transfer.status = "completed";
          transfer.local_task_id = firstValue;
          transfer.completed_at = new Date().toISOString();
          transfer.error = null;
        } else if (transfer && q.includes("STATUS = 'REJECTED'")) {
          transfer.status = "rejected";
          transfer.completed_at = new Date().toISOString();
          transfer.error = firstValue;
        }
      } else if (q.startsWith("UPDATE STAGE_RUN")) {
        const [status, result, feedback, id] = bindValues as [
          StageRun["status"],
          string | null,
          string | null,
          string,
        ];
        const run = tables.stage_run.find((row) => row.id === id);
        if (run) {
          run.status = status;
          run.result = result;
          run.feedback = feedback;
          run.finished_at = currentTimestamp();
        }
      } else if (q.startsWith("DELETE FROM TASK_PORT WHERE PIPELINE_ITEM_ID")) {
        const [itemId] = bindValues as [string];
        tables.task_port = tables.task_port.filter((p) => p.pipeline_item_id !== itemId);
      } else if (q.startsWith("UPDATE PIPELINE_ITEM SET TAGS")) {
        const [newTags, id] = bindValues as string[];
        const item = tables.pipeline_item.find((p) => p.id === id);
        if (item) {
          item.tags = newTags;
          item.updated_at = new Date().toISOString();
        }
      } else if (q.startsWith("UPDATE PIPELINE_ITEM SET PARENT_TASK_ID")) {
        const [parentTaskId, id] = bindValues as [string | null, string];
        const item = tables.pipeline_item.find((p) => p.id === id);
        if (item) {
          item.parent_task_id = parentTaskId;
          item.updated_at = new Date().toISOString();
        }
      } else if (q.startsWith("UPDATE PIPELINE_ITEM SET") && q.includes("TEARDOWN_STARTED_AT")) {
        const [id] = bindValues as string[];
        const item = tables.pipeline_item.find((p) => p.id === id);
        if (item) {
          item.teardown_started_at = new Date().toISOString();
          item.updated_at = new Date().toISOString();
        }
      } else if (q.startsWith("UPDATE PIPELINE_ITEM SET STAGE =")) {
        const [stage, id] = bindValues as string[];
        const item = tables.pipeline_item.find((p) => p.id === id);
        if (item && (!q.includes("CLOSED_AT IS NULL") || item.closed_at === null)) {
          item.stage = stage;
          item.updated_at = new Date().toISOString();
        }
      } else if (q.startsWith("INSERT INTO ACTIVITY_LOG")) {
        // Activity totals are covered by SQL integration; this mock only needs
        // to preserve the closed-row WHERE behavior for query helper tests.
      } else if (q.startsWith("UPDATE PIPELINE_ITEM SET ACTIVITY =")) {
        const [activity, id] = bindValues as [PipelineItem["activity"], string, PipelineItem["activity"]];
        const item = tables.pipeline_item.find((p) => p.id === id);
        if (item && (!q.includes("CLOSED_AT IS NULL") || item.closed_at === null) && item.activity !== activity) {
          item.activity = activity;
          item.activity_changed_at = new Date().toISOString();
          item.updated_at = new Date().toISOString();
        }
      } else if (q.startsWith("UPDATE PIPELINE_ITEM SET STAGE_RESULT = NULL")) {
        const [id] = bindValues as string[];
        const item = tables.pipeline_item.find((p) => p.id === id);
        if (item) {
          item.stage_result = null;
          item.updated_at = new Date().toISOString();
        }
      } else if (q.startsWith("UPDATE PIPELINE_ITEM SET STAGE_RESULT =")) {
        const [result, id] = bindValues as string[];
        const item = tables.pipeline_item.find((p) => p.id === id);
        if (item) {
          item.stage_result = result;
          item.updated_at = new Date().toISOString();
        }
      } else if (q.startsWith("UPDATE PIPELINE_ITEM SET ACTIVE_POST_ACTION = NULL")) {
        const [id] = bindValues as string[];
        const item = tables.pipeline_item.find((p) => p.id === id);
        if (item) {
          item.active_post_action = null;
          item.updated_at = new Date().toISOString();
        }
      } else if (q.startsWith("UPDATE PIPELINE_ITEM SET ACTIVE_POST_ACTION =")) {
        const [activePostAction, id] = bindValues as string[];
        const item = tables.pipeline_item.find((p) => p.id === id);
        if (item) {
          item.active_post_action = activePostAction;
          item.updated_at = new Date().toISOString();
        }
      } else if (q.startsWith("UPDATE PIPELINE_ITEM SET PR_NUMBER")) {
        const [prNumber, prUrl, id] = bindValues as unknown[];
        const item = tables.pipeline_item.find((p) => p.id === id);
        if (item) {
          item.pr_number = prNumber as number;
          item.pr_url = prUrl as string;
          item.updated_at = new Date().toISOString();
        }
      } else if (q.startsWith("UPDATE PIPELINE_ITEM SET PINNED = 1")) {
        const [pinOrder, id] = bindValues as unknown[];
        const item = tables.pipeline_item.find((p) => p.id === id);
        if (item) {
          (item as any).pinned = 1;
          (item as any).pin_order = pinOrder as number;
          item.updated_at = new Date().toISOString();
        }
      } else if (q.startsWith("UPDATE PIPELINE_ITEM SET PINNED = 0")) {
        const [id] = bindValues as string[];
        const item = tables.pipeline_item.find((p) => p.id === id);
        if (item) {
          (item as any).pinned = 0;
          (item as any).pin_order = null;
          item.updated_at = new Date().toISOString();
        }
      } else if (q.startsWith("UPDATE PIPELINE_ITEM SET PIN_ORDER = CASE")) {
        if (bindValues) {
          const n = Math.round(bindValues.length / 3);
          for (let i = 0; i < n; i++) {
            const id = bindValues[i * 2] as string;
            const order = bindValues[i * 2 + 1] as number;
            const item = tables.pipeline_item.find((p) => p.id === id);
            if (item) {
              (item as any).pin_order = order;
              item.updated_at = new Date().toISOString();
            }
          }
        }
      } else if (q.startsWith("INSERT INTO SETTINGS")) {
        const [key, value] = bindValues as string[];
        const existing = tables.settings.find((s) => s.key === key);
        if (existing) {
          existing.value = value;
        } else {
          tables.settings.push({ key, value });
        }
      } else if (q.startsWith("INSERT INTO OPERATOR_EVENT")) {
        const [event_type, pipeline_item_id, repo_id] = bindValues as [string, string | null, string | null];
        tables.operator_event.push({ event_type: event_type as OperatorEvent["event_type"], pipeline_item_id, repo_id });
      }

      return { rowsAffected: 1 };
    },
    async select<T>(query: string, bindValues?: unknown[]): Promise<T[]> {
      const q = query.trim().toUpperCase();

      if (q.startsWith("SELECT * FROM REPO WHERE ID")) {
        const [id] = bindValues as string[];
        return tables.repo.filter((r) => r.id === id) as unknown as T[];
      } else if (q.startsWith("SELECT * FROM REPO WHERE PATH")) {
        const [path] = bindValues as string[];
        return tables.repo.filter((r) => r.path === path) as unknown as T[];
      } else if (q.startsWith("SELECT * FROM REPO WHERE HIDDEN")) {
        return tables.repo.filter((r) => r.hidden === 0).sort(
          (a, b) =>
            a.sort_order - b.sort_order ||
            new Date(a.created_at).getTime() -
              new Date(b.created_at).getTime()
        ) as unknown as T[];
      } else if (q.startsWith("SELECT * FROM REPO")) {
        return [...tables.repo].sort(
          (a, b) =>
            a.sort_order - b.sort_order ||
            new Date(a.created_at).getTime() -
              new Date(b.created_at).getTime()
        ) as unknown as T[];
      } else if (q.startsWith("SELECT * FROM PIPELINE_ITEM WHERE REPO_ID") && q.includes("STAGE != 'DONE'")) {
        const [repoId] = bindValues as string[];
        return tables.pipeline_item.filter(
          (p) => p.repo_id === repoId && p.stage !== "done" && p.closed_at === null
        ) as unknown as T[];
      } else if (q.startsWith("SELECT * FROM PIPELINE_ITEM WHERE REPO_ID") && q.includes("CLOSED_AT IS NULL")) {
        const [repoId] = bindValues as string[];
        return tables.pipeline_item.filter(
          (p) => p.repo_id === repoId && p.closed_at === null
        ) as unknown as T[];
      } else if (q.startsWith("SELECT * FROM PIPELINE_ITEM WHERE REPO_ID")) {
        const [repoId] = bindValues as string[];
        return tables.pipeline_item.filter(
          (p) => p.repo_id === repoId
        ) as unknown as T[];
      } else if (q.startsWith("SELECT * FROM TASK_BLOCKER WHERE BLOCKED_ITEM_ID")) {
        const [blockedItemId] = bindValues as [string];
        return tables.task_blocker.filter(
          (row) => row.blocked_item_id === blockedItemId
        ) as unknown as T[];
      } else if (q.startsWith("SELECT * FROM TASK_PORT WHERE PIPELINE_ITEM_ID")) {
        const [itemId] = bindValues as [string];
        return tables.task_port.filter(
          (p) => p.pipeline_item_id === itemId
        ) as unknown as T[];
      } else if (q.startsWith("SELECT * FROM TASK_PORT")) {
        return [...tables.task_port].sort((a, b) => a.port - b.port) as unknown as T[];
      } else if (q.startsWith("SELECT * FROM TRUSTED_PEER")) {
        return [...tables.trusted_peer].sort((a, b) => {
          const aTime = new Date(a.last_seen_at ?? a.paired_at).getTime();
          const bTime = new Date(b.last_seen_at ?? b.paired_at).getTime();
          return bTime - aTime;
        }) as unknown as T[];
      } else if (q.startsWith("SELECT * FROM TASK_TRANSFER WHERE LOCAL_TASK_ID")) {
        const [localTaskId] = bindValues as [string];
        return tables.task_transfer
          .filter((transfer) => transfer.local_task_id === localTaskId)
          .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime()) as unknown as T[];
      } else if (q.startsWith("SELECT * FROM TASK_TRANSFER WHERE ID")) {
        const [transferId] = bindValues as [string];
        return tables.task_transfer
          .filter((transfer) => transfer.id === transferId) as unknown as T[];
      } else if (q.startsWith("SELECT * FROM TASK_TRANSFER_PROVENANCE WHERE PIPELINE_ITEM_ID")) {
        const [pipelineItemId] = bindValues as [string];
        return tables.task_transfer_provenance.filter((row) => row.pipeline_item_id === pipelineItemId) as unknown as T[];
      } else if (q.startsWith("SELECT * FROM STAGE_RUN WHERE TASK_ID")) {
        const [taskId] = bindValues as [string];
        return tables.stage_run
          .filter((row) => row.task_id === taskId)
          .sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime()) as unknown as T[];
      } else if (q.startsWith("SELECT PIPELINE_ITEM_ID FROM TASK_PORT WHERE PORT")) {
        const [port] = bindValues as [number];
        const row = tables.task_port.find((p) => p.port === port);
        return row ? [{ pipeline_item_id: row.pipeline_item_id } as unknown as T] : [];
      } else if (q.startsWith("SELECT TAGS FROM PIPELINE_ITEM WHERE ID")) {
        const [id] = bindValues as string[];
        const item = tables.pipeline_item.find((p) => p.id === id);
        return item ? [{ tags: item.tags } as unknown as T] : [];
      } else if (q.startsWith("SELECT * FROM SETTINGS WHERE KEY")) {
        const [key] = bindValues as string[];
        return tables.settings.filter(
          (s) => s.key === key
        ) as unknown as T[];
      }

      return [] as T[];
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("repo queries", () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    db = createMockDb();
  });

  it("listRepos returns empty array initially", async () => {
    expect(await listRepos(db)).toEqual([]);
  });

  it("insertRepo and listRepos", async () => {
    await insertRepo(db, {
      id: "r1",
      path: "/home/user/project",
      name: "project",
      default_branch: "main",
    });
    const repos = await listRepos(db);
    expect(repos).toHaveLength(1);
    expect(repos[0].id).toBe("r1");
    expect(repos[0].name).toBe("project");
  });

  it("listRepos keeps newly added repos at the bottom", async () => {
    db.setNow("2026-01-01T00:00:00.000Z");
    await insertRepo(db, {
      id: "r1",
      path: "/home/user/project-a",
      name: "project-a",
      default_branch: "main",
    });
    db.setNow("2026-01-01T00:00:01.000Z");
    await insertRepo(db, {
      id: "r2",
      path: "/home/user/project-b",
      name: "project-b",
      default_branch: "main",
    });

    const repos = await listRepos(db);

    expect(repos.map((repo) => repo.id)).toEqual(["r1", "r2"]);
  });

  it("reorderRepos persists a custom repository order", async () => {
    await insertRepo(db, {
      id: "r1",
      path: "/home/user/project-a",
      name: "project-a",
      default_branch: "main",
    });
    await insertRepo(db, {
      id: "r2",
      path: "/home/user/project-b",
      name: "project-b",
      default_branch: "main",
    });
    await insertRepo(db, {
      id: "r3",
      path: "/home/user/project-c",
      name: "project-c",
      default_branch: "main",
    });

    await reorderRepos(db, ["r3", "r1", "r2"]);

    const repos = await listRepos(db);
    expect(repos.map((repo) => repo.id)).toEqual(["r3", "r1", "r2"]);
  });

  it("updateRepoName changes only the repository display name", async () => {
    await insertRepo(db, {
      id: "r1",
      path: "/home/user/project",
      name: "project",
      default_branch: "main",
    });

    await updateRepoName(db, "r1", "Client App");

    const updated = await getRepo(db, "r1");
    expect(updated?.name).toBe("Client App");
    expect(updated?.path).toBe("/home/user/project");
    expect(updated?.default_branch).toBe("main");
  });

  it("stores and updates repository remote metadata", async () => {
    await insertRepo(db, {
      id: "r1",
      path: "/home/user/project",
      name: "project",
      default_branch: "main",
      remote_url: "git@github.com:owner/project.git",
      remote_url_hash: "hash-1",
    });

    let repo = await getRepo(db, "r1");
    expect(repo?.remote_url).toBe("git@github.com:owner/project.git");
    expect(repo?.remote_url_hash).toBe("hash-1");

    await updateRepoRemoteMetadata(db, "r1", {
      remote_url: "https://github.com/owner/project.git",
      remote_url_hash: "hash-2",
    });

    repo = await getRepo(db, "r1");
    expect(repo?.remote_url).toBe("https://github.com/owner/project.git");
    expect(repo?.remote_url_hash).toBe("hash-2");
  });

  it("getRepo returns the correct repo", async () => {
    await insertRepo(db, {
      id: "r1",
      path: "/path",
      name: "foo",
      default_branch: "main",
    });
    const repo = await getRepo(db, "r1");
    expect(repo).not.toBeNull();
    expect(repo!.id).toBe("r1");
  });

  it("getRepo returns null for unknown id", async () => {
    const repo = await getRepo(db, "unknown");
    expect(repo).toBeNull();
  });

  it("deleteRepo removes the repo", async () => {
    await insertRepo(db, {
      id: "r1",
      path: "/path",
      name: "foo",
      default_branch: "main",
    });
    await deleteRepo(db, "r1");
    expect(await listRepos(db)).toHaveLength(0);
  });
});

describe("repo hide/unhide queries", () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(async () => {
    db = createMockDb();
    await insertRepo(db, {
      id: "r1",
      path: "/home/user/project-a",
      name: "project-a",
      default_branch: "main",
    });
    await insertRepo(db, {
      id: "r2",
      path: "/home/user/project-b",
      name: "project-b",
      default_branch: "main",
    });
  });

  it("hideRepo sets hidden to 1", async () => {
    await hideRepo(db, "r1");
    const repo = db.tables.repo.find((r) => r.id === "r1");
    expect(repo?.hidden).toBe(1);
  });

  it("listRepos excludes hidden repos", async () => {
    await hideRepo(db, "r1");
    const repos = await listRepos(db);
    expect(repos).toHaveLength(1);
    expect(repos[0].id).toBe("r2");
  });

  it("unhideRepo sets hidden back to 0", async () => {
    await hideRepo(db, "r1");
    await unhideRepo(db, "r1");
    const repos = await listRepos(db);
    expect(repos).toHaveLength(2);
  });

  it("findRepoByPath returns repo including hidden", async () => {
    await hideRepo(db, "r1");
    const repo = await findRepoByPath(db, "/home/user/project-a");
    expect(repo).not.toBeNull();
    expect(repo!.id).toBe("r1");
    expect(repo!.hidden).toBe(1);
  });

  it("findRepoByPath returns null for unknown path", async () => {
    const repo = await findRepoByPath(db, "/nonexistent");
    expect(repo).toBeNull();
  });
});

describe("pipeline_item queries", () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    db = createMockDb();
  });

  it("listPipelineItems returns empty array initially", async () => {
    expect(await listPipelineItems(db, "r1")).toEqual([]);
  });

  it("insertPipelineItem and listPipelineItems", async () => {
    await insertPipelineItem(db, {
      id: "pi1",
      repo_id: "r1",
      issue_number: 42,
      issue_title: "Fix bug",
      prompt: null,
      tags: [],
      pr_number: null,
      pr_url: null,
      branch: null,
      agent_type: null,
      agent_provider: "claude",
      activity: "idle",
      port_offset: null,
      port_env: null,
    });
    const items = await listPipelineItems(db, "r1");
    expect(items).toHaveLength(1);
    expect(items[0].tags).toBe("[]");
  });

  it("insertPipelineItem persists parent_task_id and updatePipelineItemParent sets/clears it", async () => {
    await insertPipelineItem(db, {
      id: "parent",
      repo_id: "r1",
      issue_number: null,
      issue_title: null,
      prompt: "parent",
      tags: [],
      pr_number: null,
      pr_url: null,
      branch: "task-parent",
      agent_type: "pty",
      agent_provider: "claude",
      activity: "idle",
      port_offset: null,
      port_env: null,
    });
    await insertPipelineItem(db, {
      id: "child",
      repo_id: "r1",
      issue_number: null,
      issue_title: null,
      prompt: "child",
      tags: [],
      pr_number: null,
      pr_url: null,
      branch: "task-child",
      agent_type: "pty",
      agent_provider: "claude",
      activity: "idle",
      port_offset: null,
      port_env: null,
      parent_task_id: "parent",
    });

    const initial = await listPipelineItems(db, "r1");
    expect(initial.find((item) => item.id === "child")?.parent_task_id).toBe("parent");
    expect(initial.find((item) => item.id === "parent")?.parent_task_id).toBeNull();

    await updatePipelineItemParent(db, "child", null);
    const cleared = await listPipelineItems(db, "r1");
    expect(cleared.find((item) => item.id === "child")?.parent_task_id).toBeNull();

    await updatePipelineItemParent(db, "child", "parent");
    const reattached = await listPipelineItems(db, "r1");
    expect(reattached.find((item) => item.id === "child")?.parent_task_id).toBe("parent");
  });

  it("listPipelineItems excludes closed rows even when stage is still active", async () => {
    await insertPipelineItem(db, {
      id: "open",
      repo_id: "r1",
      issue_number: null,
      issue_title: null,
      prompt: "open",
      tags: [],
      pr_number: null,
      pr_url: null,
      branch: "task-open",
      agent_type: "pty",
      agent_provider: "claude",
      activity: "idle",
      port_offset: null,
      port_env: null,
    });
    await insertPipelineItem(db, {
      id: "closed-pr",
      repo_id: "r1",
      issue_number: null,
      issue_title: null,
      prompt: "closed",
      stage: "pr",
      tags: [],
      pr_number: null,
      pr_url: null,
      branch: "task-closed-pr",
      agent_type: "pty",
      agent_provider: "claude",
      activity: "idle",
      port_offset: null,
      port_env: null,
    });
    const closed = db.tables.pipeline_item.find((item) => item.id === "closed-pr");
    if (closed) {
      closed.closed_at = "2026-05-31 10:56:44";
    }

    const items = await listPipelineItems(db, "r1");

    expect(items.map((item) => item.id)).toEqual(["open"]);
  });

  it("listTaskPorts returns ports in ascending order", async () => {
    db.tables.task_port.push(
      { port: 5174, pipeline_item_id: "pi2", env_name: "KANNA_DEV_PORT", created_at: new Date().toISOString() },
      { port: 5173, pipeline_item_id: "pi1", env_name: "KANNA_DEV_PORT", created_at: new Date().toISOString() },
    );

    const ports = await listTaskPorts(db);

    expect(ports.map((port) => port.port)).toEqual([5173, 5174]);
  });

  it("listTaskPortsForItem returns only rows for that item", async () => {
    db.tables.task_port.push(
      { port: 5173, pipeline_item_id: "pi1", env_name: "KANNA_DEV_PORT", created_at: new Date().toISOString() },
      { port: 9080, pipeline_item_id: "pi1", env_name: "KANNA_RELAY_PORT", created_at: new Date().toISOString() },
      { port: 5175, pipeline_item_id: "pi2", env_name: "KANNA_DEV_PORT", created_at: new Date().toISOString() },
    );

    const ports = await listTaskPortsForItem(db, "pi1");

    expect(ports.map((port) => port.env_name)).toEqual(["KANNA_DEV_PORT", "KANNA_RELAY_PORT"]);
  });

  it("deleteTaskPortsForItem removes all ports for an item", async () => {
    db.tables.task_port.push(
      { port: 5173, pipeline_item_id: "pi1", env_name: "KANNA_DEV_PORT", created_at: new Date().toISOString() },
      { port: 9080, pipeline_item_id: "pi1", env_name: "KANNA_RELAY_PORT", created_at: new Date().toISOString() },
      { port: 5175, pipeline_item_id: "pi2", env_name: "KANNA_DEV_PORT", created_at: new Date().toISOString() },
    );

    await deleteTaskPortsForItem(db, "pi1");

    expect(db.tables.task_port.map((port) => port.pipeline_item_id)).toEqual(["pi2"]);
  });

  it("throws when insertPipelineItem is called without an agent provider", async () => {
    await expect(
      insertPipelineItem(db, {
        id: "pi1",
        repo_id: "r1",
        issue_number: null,
        issue_title: null,
        prompt: "do it",
        tags: [],
        pr_number: null,
        pr_url: null,
        branch: null,
        agent_type: null,
        agent_provider: undefined as never,
        activity: "idle",
        port_offset: null,
        port_env: null,
      }),
    ).rejects.toThrow("No agent provider configured for pipeline item insertion.");
  });

  it("insertPipelineItem with tags", async () => {
    await insertPipelineItem(db, {
      id: "pi1",
      repo_id: "r1",
      issue_number: null,
      issue_title: null,
      prompt: "do it",
      tags: ["pr"],
      pr_number: null,
      pr_url: null,
      branch: null,
      agent_type: null,
      agent_provider: "claude",
      activity: "idle",
      port_offset: null,
      port_env: null,
    });
    const item = db.tables.pipeline_item.find((p) => p.id === "pi1");
    expect(item?.tags).toBe('["pr"]');
  });

  it("updatePipelineItemPR sets pr_number and pr_url", async () => {
    await insertPipelineItem(db, {
      id: "pi1",
      repo_id: "r1",
      issue_number: null,
      issue_title: null,
      prompt: null,
      tags: [],
      pr_number: null,
      pr_url: null,
      branch: "feature/x",
      agent_type: null,
      agent_provider: "claude",
      activity: "idle",
      port_offset: null,
      port_env: null,
    });
    await updatePipelineItemPR(db, "pi1", 99, "https://github.com/o/r/pull/99");
    const item = db.tables.pipeline_item.find((p) => p.id === "pi1");
    expect(item?.pr_number).toBe(99);
    expect(item?.pr_url).toBe("https://github.com/o/r/pull/99");
  });

  it("insertPipelineItem defaults pipeline to 'default' and stage to 'in progress'", async () => {
    await insertPipelineItem(db, {
      id: "pi1",
      repo_id: "r1",
      issue_number: null,
      issue_title: null,
      prompt: "do it",
      tags: [],
      pr_number: null,
      pr_url: null,
      branch: null,
      agent_type: null,
      agent_provider: "claude",
      activity: "idle",
      port_offset: null,
      port_env: null,
    });
    const item = db.tables.pipeline_item.find((p) => p.id === "pi1");
    expect(item?.pipeline).toBe("default");
    expect(item?.stage).toBe("in progress");
    expect(item?.stage_result).toBeNull();
    expect(item?.active_post_action).toBeNull();
  });

  it("insertPipelineItem accepts explicit pipeline and stage", async () => {
    await insertPipelineItem(db, {
      id: "pi1",
      repo_id: "r1",
      issue_number: null,
      issue_title: null,
      prompt: "do it",
      tags: [],
      pr_number: null,
      pr_url: null,
      branch: null,
      agent_type: null,
      agent_provider: "claude",
      activity: "idle",
      port_offset: null,
      port_env: null,
      pipeline: "custom",
      stage: "review",
    });
    const item = db.tables.pipeline_item.find((p) => p.id === "pi1");
    expect(item?.pipeline).toBe("custom");
    expect(item?.stage).toBe("review");
  });

  it("insertPipelineItem persists the resolved pipeline definition snapshot", async () => {
    const pipelineDef = JSON.stringify({
      stages: [
        { name: "in progress", transition: "manual" },
        { name: "review", transition: "manual" },
      ],
    });

    await insertPipelineItem(db, {
      id: "pi1",
      repo_id: "r1",
      issue_number: null,
      issue_title: null,
      prompt: "do it",
      tags: [],
      pr_number: null,
      pr_url: null,
      branch: null,
      agent_type: null,
      agent_provider: "claude",
      activity: "idle",
      port_offset: null,
      port_env: null,
      pipeline_def: pipelineDef,
    });

    const item = db.tables.pipeline_item.find((p) => p.id === "pi1");
    expect(item?.pipeline_def).toBe(pipelineDef);
  });
});

describe("stage_run queries", () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    db = createMockDb();
    db.setNow("2026-07-02T00:00:00.000Z");
  });

  it("inserts and lists stage runs for a task by start time", async () => {
    await insertStageRun(db, {
      id: "run-2",
      task_id: "task-1",
      stage: "review",
      agent: "reviewer",
      agent_provider: "claude",
      model: "sonnet",
      status: "running",
      result: null,
      feedback: null,
      session_id: "session-2",
    });
    db.setNow("2026-07-02T00:01:00.000Z");
    await insertStageRun(db, {
      id: "run-1",
      task_id: "task-1",
      stage: "in progress",
      agent: "implement",
      agent_provider: "codex",
      model: null,
      status: "succeeded",
      result: JSON.stringify({ status: "success" }),
      feedback: "done",
      session_id: "session-1",
    });

    const runs = await listStageRunsForTask(db, "task-1");

    expect(runs.map((run) => run.id)).toEqual(["run-2", "run-1"]);
    expect(runs[0]).toMatchObject({
      task_id: "task-1",
      stage: "review",
      agent_provider: "claude",
      status: "running",
      session_id: "session-2",
    });
  });

  it("finishes a stage run with terminal status, result, feedback, and finished_at", async () => {
    await insertStageRun(db, {
      id: "run-1",
      task_id: "task-1",
      stage: "in progress",
      agent: "implement",
      agent_provider: "codex",
      model: null,
      status: "running",
      result: null,
      feedback: null,
      session_id: "session-1",
    });
    db.setNow("2026-07-02T00:05:00.000Z");
    const result = JSON.stringify({ status: "success", summary: "implemented" });

    await finishStageRun(db, "run-1", {
      status: "succeeded",
      result,
      feedback: "implemented",
    });

    expect(db.tables.stage_run[0]).toMatchObject({
      id: "run-1",
      status: "succeeded",
      result,
      feedback: "implemented",
      finished_at: "2026-07-02T00:05:00.000Z",
    });
  });
});

describe("task resource queries", () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    db = createMockDb();
  });

  it("upserts task worktree rows by id", async () => {
    await insertWorktree(db, {
      id: "wt-task-1",
      pipeline_item_id: "task-1",
      path: "/tmp/repo/.kanna-worktrees/task-1",
      branch: "task-1",
    });
    await insertWorktree(db, {
      id: "wt-task-1",
      pipeline_item_id: "task-1",
      path: "/tmp/repo/.kanna-worktrees/task-1-renamed",
      branch: "task-1-renamed",
    });

    expect(db.tables.worktree).toEqual([
      expect.objectContaining({
        id: "wt-task-1",
        pipeline_item_id: "task-1",
        path: "/tmp/repo/.kanna-worktrees/task-1-renamed",
        branch: "task-1-renamed",
      }),
    ]);
  });

  it("upserts terminal session rows with daemon session ids", async () => {
    await upsertTerminalSession(db, {
      id: "agent-task-1",
      repo_id: "repo-1",
      pipeline_item_id: "task-1",
      label: "agent",
      cwd: "/tmp/repo/.kanna-worktrees/task-1",
      daemon_session_id: "daemon-task-1",
    });
    await upsertTerminalSession(db, {
      id: "agent-task-1",
      repo_id: "repo-1",
      pipeline_item_id: "task-1",
      label: "agent",
      cwd: "/tmp/repo/.kanna-worktrees/task-1-renamed",
      daemon_session_id: "daemon-task-1",
    });

    expect(db.tables.terminal_session).toEqual([
      expect.objectContaining({
        id: "agent-task-1",
        repo_id: "repo-1",
        pipeline_item_id: "task-1",
        label: "agent",
        cwd: "/tmp/repo/.kanna-worktrees/task-1-renamed",
        daemon_session_id: "daemon-task-1",
      }),
    ]);
  });
});

describe("task blocker cycle detection", () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    db = createMockDb();
  });

  it("returns false when the proposed blocker has no path back to the blocked item", async () => {
    await insertTaskBlocker(db, "B", "C");

    await expect(hasCircularDependency(db, "A", ["B"])).resolves.toBe(false);
  });

  it("returns true for a direct cycle", async () => {
    await insertTaskBlocker(db, "B", "A");

    await expect(hasCircularDependency(db, "A", ["B"])).resolves.toBe(true);
  });

  it("returns true for a transitive cycle", async () => {
    await insertTaskBlocker(db, "B", "C");
    await insertTaskBlocker(db, "C", "A");

    await expect(hasCircularDependency(db, "A", ["B"])).resolves.toBe(true);
  });

  it("returns true for self-blocking", async () => {
    await expect(hasCircularDependency(db, "A", ["A"])).resolves.toBe(true);
  });

  it("returns false for diamond-shaped non-cycles", async () => {
    await insertTaskBlocker(db, "B", "D");
    await insertTaskBlocker(db, "C", "D");

    await expect(hasCircularDependency(db, "A", ["B", "C"])).resolves.toBe(false);
  });
});

describe("stage queries", () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(async () => {
    db = createMockDb();
    await insertPipelineItem(db, {
      id: "pi1",
      repo_id: "r1",
      issue_number: null,
      issue_title: null,
      prompt: "task",
      tags: [],
      pr_number: null,
      pr_url: null,
      branch: null,
      agent_type: null,
      agent_provider: "claude",
      activity: "idle",
      port_offset: null,
      port_env: null,
    });
  });

  it("updatePipelineItemStage updates the stage field", async () => {
    await updatePipelineItemStage(db, "pi1", "review");
    const item = db.tables.pipeline_item.find((p) => p.id === "pi1");
    expect(item?.stage).toBe("review");
  });

  it("updatePipelineItemStage does not mutate closed rows", async () => {
    const item = db.tables.pipeline_item.find((p) => p.id === "pi1");
    if (item) {
      item.stage = "review";
      item.closed_at = "2026-06-03 00:02:25";
    }

    await updatePipelineItemStage(db, "pi1", "pr");

    expect(item?.stage).toBe("review");
    expect(item?.closed_at).toBe("2026-06-03 00:02:25");
  });

  it("updatePipelineItemActivity does not mutate closed rows", async () => {
    const item = db.tables.pipeline_item.find((p) => p.id === "pi1");
    if (item) {
      item.activity = "idle";
      item.activity_changed_at = "2026-06-03 00:00:00";
      item.unread_at = null;
      item.closed_at = "2026-06-03 00:02:25";
    }

    await updatePipelineItemActivity(db, "pi1", "unread");

    expect(item?.activity).toBe("idle");
    expect(item?.activity_changed_at).toBe("2026-06-03 00:00:00");
    expect(item?.unread_at).toBeNull();
    expect(item?.closed_at).toBe("2026-06-03 00:02:25");
  });

  it("markPipelineItemTearingDown marks teardown state without changing stage", async () => {
    await updatePipelineItemStage(db, "pi1", "pr");
    await markPipelineItemTearingDown(db, "pi1");
    const item = db.tables.pipeline_item.find((p) => p.id === "pi1");
    expect(item?.stage).toBe("pr");
    expect(item?.teardown_started_at).not.toBeNull();
  });

  it("updatePipelineItemTags overwrites tags for a single task", async () => {
    await updatePipelineItemTags(db, "pi1", ["in progress", "blocked"]);
    const item = db.tables.pipeline_item.find((p) => p.id === "pi1");
    expect(item?.tags).toBe('["in progress","blocked"]');
  });

  it("updatePipelineItemStageResult sets stage_result", async () => {
    const result = JSON.stringify({ outcome: "success" });
    await updatePipelineItemStageResult(db, "pi1", result);
    const item = db.tables.pipeline_item.find((p) => p.id === "pi1");
    expect(item?.stage_result).toBe(result);
  });

  it("clearPipelineItemStageResult sets stage_result to null", async () => {
    const result = JSON.stringify({ outcome: "success" });
    await updatePipelineItemStageResult(db, "pi1", result);
    await clearPipelineItemStageResult(db, "pi1");
    const item = db.tables.pipeline_item.find((p) => p.id === "pi1");
    expect(item?.stage_result).toBeNull();
  });

  it("sets and clears the active post-action", async () => {
    await updatePipelineItemActivePostAction(db, "pi1", "commit");
    expect(db.tables.pipeline_item.find((p) => p.id === "pi1")?.active_post_action).toBe("commit");

    await clearPipelineItemActivePostAction(db, "pi1");
    expect(db.tables.pipeline_item.find((p) => p.id === "pi1")?.active_post_action).toBeNull();
  });
});

describe("settings queries", () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    db = createMockDb();
  });

  it("getSetting returns null for unknown key", async () => {
    expect(await getSetting(db, "unknown")).toBeNull();
  });

  it("setSetting and getSetting round-trip", async () => {
    await setSetting(db, "suspendAfterMinutes", "10");
    expect(await getSetting(db, "suspendAfterMinutes")).toBe("10");
  });

  it("setSetting overwrites an existing value", async () => {
    await setSetting(db, "ideCommand", "cursor");
    await setSetting(db, "ideCommand", "code");
    expect(await getSetting(db, "ideCommand")).toBe("code");
  });
});

describe("pin queries", () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(async () => {
    db = createMockDb();
    await insertPipelineItem(db, {
      id: "pi1", repo_id: "r1", issue_number: null, issue_title: null,
      prompt: "task 1", tags: [], pr_number: null, pr_url: null,
      branch: null, agent_type: null,
      agent_provider: "claude", activity: "idle", port_offset: null, port_env: null,
    });
    await insertPipelineItem(db, {
      id: "pi2", repo_id: "r1", issue_number: null, issue_title: null,
      prompt: "task 2", tags: [], pr_number: null, pr_url: null,
      branch: null, agent_type: null,
      agent_provider: "claude", activity: "idle", port_offset: null, port_env: null,
    });
    await insertPipelineItem(db, {
      id: "pi3", repo_id: "r1", issue_number: null, issue_title: null,
      prompt: "task 3", tags: [], pr_number: null, pr_url: null,
      branch: null, agent_type: null,
      agent_provider: "claude", activity: "idle", port_offset: null, port_env: null,
    });
  });

  it("pinPipelineItem sets pinned and pin_order", async () => {
    await pinPipelineItem(db, "pi1", 0);
    const item = db.tables.pipeline_item.find((p) => p.id === "pi1");
    expect((item as any).pinned).toBe(1);
    expect((item as any).pin_order).toBe(0);
  });

  it("unpinPipelineItem clears pinned and pin_order", async () => {
    await pinPipelineItem(db, "pi1", 0);
    await unpinPipelineItem(db, "pi1");
    const item = db.tables.pipeline_item.find((p) => p.id === "pi1");
    expect((item as any).pinned).toBe(0);
    expect((item as any).pin_order).toBeNull();
  });

  it("reorderPinnedItems updates pin_order by array index", async () => {
    await pinPipelineItem(db, "pi1", 0);
    await pinPipelineItem(db, "pi2", 1);
    await pinPipelineItem(db, "pi3", 2);
    await reorderPinnedItems(db, "r1", ["pi3", "pi1", "pi2"]);
    expect((db.tables.pipeline_item.find((p) => p.id === "pi3") as any).pin_order).toBe(0);
    expect((db.tables.pipeline_item.find((p) => p.id === "pi1") as any).pin_order).toBe(1);
    expect((db.tables.pipeline_item.find((p) => p.id === "pi2") as any).pin_order).toBe(2);
  });
});

describe("trusted_peer queries", () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    db = createMockDb();
  });

  it("stores and revokes trusted peers", async () => {
    await insertTrustedPeer(db, {
      id: "peer-row-1",
      peer_id: "peer-alpha",
      display_name: "Jeremy's MacBook Pro",
      public_key: "pubkey-1",
      capabilities_json: JSON.stringify({ version: 1, providers: ["claude", "copilot"] }),
    });

    expect(await listTrustedPeers(db)).toHaveLength(1);

    await revokeTrustedPeer(db, "peer-alpha");

    const peers = await listTrustedPeers(db);
    expect(peers[0]?.revoked_at).toEqual(expect.any(String));
  });
});

describe("task_transfer queries", () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    db = createMockDb();
  });

  it("records transfer history and imported provenance", async () => {
    await insertTaskTransfer(db, {
      id: "tx-1",
      direction: "outgoing",
      status: "completed",
      source_peer_id: "peer-alpha",
      target_peer_id: "peer-beta",
      source_task_id: "task-source",
      local_task_id: "task-local",
      error: null,
      payload_json: null,
    });
    db.tables.task_transfer.push({
      id: "tx-0",
      direction: "incoming",
      status: "pending",
      source_peer_id: "peer-gamma",
      target_peer_id: "peer-delta",
      source_task_id: "task-older",
      local_task_id: "task-local",
      started_at: "2026-04-08T00:00:00.000Z",
      completed_at: null,
      error: "waiting",
      payload_json: null,
    });
    db.tables.task_transfer[0]!.started_at = "2026-04-08T00:00:01.000Z";

    await insertTaskTransferProvenance(db, {
      pipeline_item_id: "task-local",
      source_peer_id: "peer-alpha",
      source_task_id: "task-source",
      source_machine_task_label: "Fix daemon handoff",
    });

    const transfers = await listTaskTransfersForItem(db, "task-local");
    expect(transfers.map((transfer) => transfer.id)).toEqual(["tx-1", "tx-0"]);
    expect(transfers[0]).toMatchObject({
      source_peer_id: "peer-alpha",
      source_task_id: "task-source",
      target_peer_id: "peer-beta",
      status: "completed",
    });
    expect(await getTaskTransferProvenance(db, "task-local")).toMatchObject({
      source_peer_id: "peer-alpha",
      source_task_id: "task-source",
    });
  });

  it("returns null for missing provenance", async () => {
    expect(await getTaskTransferProvenance(db, "missing-task")).toBeNull();
  });

  it("getTaskTransfer returns the matching transfer row", async () => {
    await insertTaskTransfer(db, {
      id: "transfer-1",
      direction: "incoming",
      status: "pending",
      source_peer_id: "peer-source",
      target_peer_id: "peer-target",
      source_task_id: "task-source",
      local_task_id: null,
      error: null,
      payload_json: "{}",
    });

    expect(await getTaskTransfer(db, "transfer-1")).toMatchObject({
      id: "transfer-1",
      status: "pending",
    });
    expect(await getTaskTransfer(db, "missing-transfer")).toBeNull();
  });

  it("markTaskTransferCompleted records completion state and local task id", async () => {
    await insertTaskTransfer(db, {
      id: "transfer-1",
      direction: "incoming",
      status: "pending",
      source_peer_id: "peer-source",
      target_peer_id: "peer-target",
      source_task_id: "task-source",
      local_task_id: null,
      error: "pending",
      payload_json: "{}",
    });

    await markTaskTransferCompleted(db, "transfer-1", "task-local");

    expect(await getTaskTransfer(db, "transfer-1")).toMatchObject({
      id: "transfer-1",
      status: "completed",
      local_task_id: "task-local",
      error: null,
    });
  });

  it("markTaskTransferRejected records rejection state", async () => {
    await insertTaskTransfer(db, {
      id: "transfer-1",
      direction: "incoming",
      status: "pending",
      source_peer_id: "peer-source",
      target_peer_id: "peer-target",
      source_task_id: "task-source",
      local_task_id: null,
      error: null,
      payload_json: "{}",
    });

    await markTaskTransferRejected(db, "transfer-1", "Rejected locally");

    expect(await getTaskTransfer(db, "transfer-1")).toMatchObject({
      id: "transfer-1",
      status: "rejected",
      error: "Rejected locally",
    });
  });
});

describe("insertOperatorEvent", () => {
  it("inserts a task_selected event", async () => {
    const db = createMockDb();
    await insertOperatorEvent(db, "task_selected", "item-1", "repo-1");
    expect(db.tables.operator_event).toHaveLength(1);
    expect(db.tables.operator_event[0].event_type).toBe("task_selected");
    expect(db.tables.operator_event[0].pipeline_item_id).toBe("item-1");
    expect(db.tables.operator_event[0].repo_id).toBe("repo-1");
  });

  it("inserts an app_blur event with null item and repo", async () => {
    const db = createMockDb();
    await insertOperatorEvent(db, "app_blur", null, null);
    expect(db.tables.operator_event).toHaveLength(1);
    expect(db.tables.operator_event[0].pipeline_item_id).toBeNull();
    expect(db.tables.operator_event[0].repo_id).toBeNull();
  });
});
