import type {
  Repo,
  PipelineItem,
  Setting,
  TaskBlocker,
  TaskPort,
  TerminalSession,
  TrustedPeer,
  TaskTransfer,
  TaskTransferProvenance,
  Worktree,
} from "./schema.js";

export type DbHandle = {
  execute(query: string, bindValues?: unknown[]): Promise<{ rowsAffected: number }>;
  select<T>(query: string, bindValues?: unknown[]): Promise<T[]>;
};

// ---------------------------------------------------------------------------
// Repo
// ---------------------------------------------------------------------------

export async function listRepos(db: DbHandle): Promise<Repo[]> {
  return db.select<Repo>("SELECT * FROM repo WHERE hidden = 0 ORDER BY sort_order ASC, created_at ASC");
}

export async function getRepo(db: DbHandle, id: string): Promise<Repo | null> {
  const rows = await db.select<Repo>("SELECT * FROM repo WHERE id = ?", [id]);
  return rows[0] ?? null;
}

export async function insertRepo(
  db: DbHandle,
  repo: Omit<Repo, "created_at" | "last_opened_at" | "hidden" | "sort_order" | "remote_url" | "remote_url_hash"> & Partial<Pick<Repo, "remote_url" | "remote_url_hash">>
): Promise<void> {
  await db.execute(
    `INSERT INTO repo (id, path, name, default_branch, remote_url, remote_url_hash, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, COALESCE((SELECT MAX(sort_order) + 1 FROM repo), 0))`,
    [
      repo.id,
      repo.path,
      repo.name,
      repo.default_branch,
      repo.remote_url ?? null,
      repo.remote_url_hash ?? null,
    ]
  );
}

export async function deleteRepo(db: DbHandle, id: string): Promise<void> {
  await db.execute("DELETE FROM repo WHERE id = ?", [id]);
}

export async function hideRepo(db: DbHandle, id: string): Promise<void> {
  await db.execute("UPDATE repo SET hidden = 1 WHERE id = ?", [id]);
}

export async function unhideRepo(db: DbHandle, id: string): Promise<void> {
  await db.execute("UPDATE repo SET hidden = 0 WHERE id = ?", [id]);
}

export async function updateRepoName(db: DbHandle, id: string, name: string): Promise<void> {
  await db.execute("UPDATE repo SET name = ? WHERE id = ?", [name, id]);
}

export async function updateRepoRemoteMetadata(
  db: DbHandle,
  id: string,
  metadata: Pick<Repo, "remote_url" | "remote_url_hash">,
): Promise<void> {
  await db.execute(
    "UPDATE repo SET remote_url = ?, remote_url_hash = ? WHERE id = ?",
    [metadata.remote_url, metadata.remote_url_hash, id],
  );
}

export async function reorderRepos(db: DbHandle, orderedIds: string[]): Promise<void> {
  for (const [index, id] of orderedIds.entries()) {
    await db.execute("UPDATE repo SET sort_order = ? WHERE id = ?", [index, id]);
  }
}

/** Includes hidden repos — callers must check `existing.hidden`. */
export async function findRepoByPath(db: DbHandle, path: string): Promise<Repo | null> {
  const rows = await db.select<Repo>("SELECT * FROM repo WHERE path = ?", [path]);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// PipelineItem
// ---------------------------------------------------------------------------

export async function listPipelineItems(
  db: DbHandle,
  repoId: string
): Promise<PipelineItem[]> {
  return db.select<PipelineItem>(
    "SELECT * FROM pipeline_item WHERE repo_id = ? AND closed_at IS NULL ORDER BY created_at DESC",
    [repoId]
  );
}

export async function listTaskPorts(db: DbHandle): Promise<TaskPort[]> {
  return db.select<TaskPort>("SELECT * FROM task_port ORDER BY port ASC");
}

export async function listTaskPortsForItem(
  db: DbHandle,
  itemId: string,
): Promise<TaskPort[]> {
  return db.select<TaskPort>(
    "SELECT * FROM task_port WHERE pipeline_item_id = ? ORDER BY port ASC",
    [itemId],
  );
}

export async function deleteTaskPortsForItem(
  db: DbHandle,
  itemId: string,
): Promise<void> {
  await db.execute("DELETE FROM task_port WHERE pipeline_item_id = ?", [itemId]);
}

export async function listTaskBlockers(db: DbHandle): Promise<TaskBlocker[]> {
  return db.select<TaskBlocker>("SELECT * FROM task_blocker");
}

export async function insertWorktree(
  db: DbHandle,
  worktree: Omit<Worktree, "created_at">,
): Promise<void> {
  await db.execute(
    `INSERT INTO worktree (id, pipeline_item_id, path, branch)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       pipeline_item_id = excluded.pipeline_item_id,
       path = excluded.path,
       branch = excluded.branch`,
    [worktree.id, worktree.pipeline_item_id, worktree.path, worktree.branch],
  );
}

export async function upsertTerminalSession(
  db: DbHandle,
  session: Omit<TerminalSession, "created_at">,
): Promise<void> {
  await db.execute(
    `INSERT INTO terminal_session (id, repo_id, pipeline_item_id, label, cwd, daemon_session_id)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       repo_id = excluded.repo_id,
       pipeline_item_id = excluded.pipeline_item_id,
       label = excluded.label,
       cwd = excluded.cwd,
       daemon_session_id = excluded.daemon_session_id`,
    [
      session.id,
      session.repo_id,
      session.pipeline_item_id,
      session.label,
      session.cwd,
      session.daemon_session_id,
    ],
  );
}

export async function insertPipelineItem(
  db: DbHandle,
  item: Omit<PipelineItem, "created_at" | "updated_at" | "activity_changed_at" | "unread_at" | "pinned" | "pin_order" | "display_name" | "closed_at" | "pipeline" | "stage" | "base_ref" | "agent_session_id" | "teardown_started_at" | "last_output_preview" | "agent_spawn_options" | "parent_task_id" | "notify_task_id" | "notified_at" | "pipeline_def"> & { pipeline?: string; stage?: string; activity?: PipelineItem["activity"]; display_name?: string | null; base_ref?: string | null; agent_spawn_options?: string | null; parent_task_id?: string | null; pipeline_def?: string | null }
): Promise<void> {
  if (!item.agent_provider) {
    throw new Error("No agent provider configured for pipeline item insertion.");
  }
  await db.execute(
    `INSERT INTO pipeline_item
       (id, repo_id, issue_number, issue_title, prompt, pipeline, stage, pr_number, pr_url, branch, agent_type, agent_provider, port_offset, port_env, agent_spawn_options, activity, activity_changed_at, display_name, base_ref, parent_task_id, pipeline_def)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?)`,
    [
      item.id,
      item.repo_id,
      item.issue_number,
      item.issue_title,
      item.prompt,
      item.pipeline ?? "default",
      item.stage ?? "in progress",
      item.pr_number,
      item.pr_url,
      item.branch,
      item.agent_type,
      item.agent_provider,
      item.port_offset ?? null,
      item.port_env ?? null,
      item.agent_spawn_options ?? null,
      item.activity ?? "idle",
      item.display_name ?? null,
      item.base_ref ?? null,
      item.parent_task_id ?? null,
      item.pipeline_def ?? null,
    ]
  );
}

export async function updatePipelineItemStage(
  db: DbHandle,
  id: string,
  stage: string
): Promise<void> {
  await db.execute(
    `UPDATE pipeline_item SET stage = ?, updated_at = datetime('now') WHERE id = ? AND closed_at IS NULL`,
    [stage, id]
  );
}

export async function markPipelineItemTearingDown(
  db: DbHandle,
  id: string,
): Promise<void> {
  await db.execute(
    `UPDATE pipeline_item SET
       teardown_started_at = COALESCE(teardown_started_at, datetime('now')),
       updated_at = datetime('now')
     WHERE id = ?`,
    [id],
  );
}

export async function updatePipelineItemPR(
  db: DbHandle,
  id: string,
  prNumber: number,
  prUrl: string
): Promise<void> {
  await db.execute(
    "UPDATE pipeline_item SET pr_number = ?, pr_url = ?, updated_at = datetime('now') WHERE id = ?",
    [prNumber, prUrl, id]
  );
}

export async function updatePipelineItemActivity(
  db: DbHandle,
  id: string,
  activity: "working" | "unread" | "idle"
): Promise<void> {
  const unreadClause = activity === "unread" ? ", unread_at = datetime('now')" : "";
  // Accumulate elapsed seconds in the current state before transitioning away.
  // The WHERE activity != ? guard ensures we only accumulate on real transitions.
  await db.execute(
    `INSERT INTO activity_log (pipeline_item_id, activity, seconds)
     SELECT id, activity, CAST((julianday('now') - julianday(COALESCE(activity_changed_at, created_at))) * 86400 AS INTEGER)
     FROM pipeline_item WHERE id = ? AND activity != ? AND closed_at IS NULL
     ON CONFLICT (pipeline_item_id, activity) DO UPDATE SET seconds = seconds + excluded.seconds`,
    [id, activity]
  );
  const result = await db.execute(
    `UPDATE pipeline_item SET activity = ?, activity_changed_at = datetime('now')${unreadClause}, updated_at = datetime('now') WHERE id = ? AND activity != ? AND closed_at IS NULL`,
    [activity, id, activity]
  );
  if (result.rowsAffected === 0) return;
}

export async function pinPipelineItem(
  db: DbHandle,
  id: string,
  pinOrder: number
): Promise<void> {
  await db.execute(
    "UPDATE pipeline_item SET pinned = 1, pin_order = ?, updated_at = datetime('now') WHERE id = ?",
    [pinOrder, id]
  );
}

export async function unpinPipelineItem(
  db: DbHandle,
  id: string
): Promise<void> {
  await db.execute(
    "UPDATE pipeline_item SET pinned = 0, pin_order = NULL, updated_at = datetime('now') WHERE id = ?",
    [id]
  );
}

export async function updatePipelineItemDisplayName(
  db: DbHandle,
  id: string,
  displayName: string | null
): Promise<void> {
  await db.execute(
    "UPDATE pipeline_item SET display_name = ?, updated_at = datetime('now') WHERE id = ?",
    [displayName, id]
  );
}

export async function updatePipelineItemParent(
  db: DbHandle,
  id: string,
  parentTaskId: string | null
): Promise<void> {
  await db.execute(
    "UPDATE pipeline_item SET parent_task_id = ?, updated_at = datetime('now') WHERE id = ?",
    [parentTaskId, id]
  );
}

export async function updatePipelineItemLastOutputPreview(
  db: DbHandle,
  id: string,
  preview: string | null
): Promise<void> {
  await db.execute(
    "UPDATE pipeline_item SET last_output_preview = ?, updated_at = datetime('now') WHERE id = ?",
    [preview, id]
  );
}

export async function updateAgentSessionId(
  db: DbHandle,
  id: string,
  agentSessionId: string
): Promise<void> {
  await db.execute(
    "UPDATE pipeline_item SET agent_session_id = ?, updated_at = datetime('now') WHERE id = ?",
    [agentSessionId, id]
  );
}

export async function closePipelineItem(
  db: DbHandle,
  id: string
): Promise<void> {
  await db.execute(
    `UPDATE pipeline_item SET
       teardown_started_at = NULL,
       closed_at = datetime('now'),
       updated_at = datetime('now')
     WHERE id = ?`,
    [id]
  );
}

export async function reopenPipelineItem(
  db: DbHandle,
  id: string
): Promise<void> {
  await db.execute(
    `UPDATE pipeline_item SET
       teardown_started_at = NULL,
       closed_at = NULL,
       updated_at = datetime('now')
     WHERE id = ?`,
    [id]
  );
}

export async function reorderPinnedItems(
  db: DbHandle,
  _repoId: string,
  orderedIds: string[]
): Promise<void> {
  if (orderedIds.length === 0) return;
  const cases = orderedIds.map(() => `WHEN ? THEN ?`).join(" ");
  const placeholders = orderedIds.map(() => "?").join(", ");
  const bindValues: unknown[] = [];
  for (let i = 0; i < orderedIds.length; i++) {
    bindValues.push(orderedIds[i], i);
  }
  bindValues.push(...orderedIds);
  await db.execute(
    `UPDATE pipeline_item SET pin_order = CASE id ${cases} END, updated_at = datetime('now') WHERE id IN (${placeholders})`,
    bindValues
  );
}

// ---------------------------------------------------------------------------
// TaskBlocker
// ---------------------------------------------------------------------------

export async function insertTaskBlocker(
  db: DbHandle,
  blockedItemId: string,
  blockerItemId: string,
): Promise<void> {
  await db.execute(
    "INSERT OR IGNORE INTO task_blocker (blocked_item_id, blocker_item_id) VALUES (?, ?)",
    [blockedItemId, blockerItemId],
  );
}

export async function removeTaskBlocker(
  db: DbHandle,
  blockedItemId: string,
  blockerItemId: string,
): Promise<void> {
  await db.execute(
    "DELETE FROM task_blocker WHERE blocked_item_id = ? AND blocker_item_id = ?",
    [blockedItemId, blockerItemId],
  );
}

export async function removeAllBlockersForItem(
  db: DbHandle,
  blockedItemId: string,
): Promise<void> {
  await db.execute(
    "DELETE FROM task_blocker WHERE blocked_item_id = ?",
    [blockedItemId],
  );
}

export async function listBlockersForItem(
  db: DbHandle,
  blockedItemId: string,
): Promise<PipelineItem[]> {
  return db.select<PipelineItem>(
    `SELECT pi.* FROM pipeline_item pi
     JOIN task_blocker tb ON pi.id = tb.blocker_item_id
     WHERE tb.blocked_item_id = ?`,
    [blockedItemId],
  );
}

export async function listBlockedByItem(
  db: DbHandle,
  blockerItemId: string,
): Promise<PipelineItem[]> {
  return db.select<PipelineItem>(
    `SELECT pi.* FROM pipeline_item pi
     JOIN task_blocker tb ON pi.id = tb.blocked_item_id
     WHERE tb.blocker_item_id = ?`,
    [blockerItemId],
  );
}

export async function getUnblockedItems(
  db: DbHandle,
): Promise<PipelineItem[]> {
  // A task is "blocked" if it has entries in task_blocker.
  // It becomes "unblocked" when all its blockers have closed_at set.
  return db.select<PipelineItem>(
    `SELECT pi.* FROM pipeline_item pi
     WHERE EXISTS (
       SELECT 1 FROM task_blocker tb WHERE tb.blocked_item_id = pi.id
     )
     AND pi.closed_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM task_blocker tb
       JOIN pipeline_item blocker ON blocker.id = tb.blocker_item_id
       WHERE tb.blocked_item_id = pi.id
       AND blocker.closed_at IS NULL
     )`,
  );
}

export async function hasCircularDependency(
  db: DbHandle,
  blockedItemId: string,
  proposedBlockerIds: string[],
): Promise<boolean> {
  const visited = new Set<string>();

  async function dfs(currentId: string): Promise<boolean> {
    if (currentId === blockedItemId) return true;
    if (visited.has(currentId)) return false;
    visited.add(currentId);
    const blockers = await db.select<TaskBlocker>(
      "SELECT * FROM task_blocker WHERE blocked_item_id = ?",
      [currentId],
    );
    for (const b of blockers) {
      if (await dfs(b.blocker_item_id)) return true;
    }
    return false;
  }

  for (const blockerId of proposedBlockerIds) {
    visited.clear();
    if (await dfs(blockerId)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// TrustedPeer
// ---------------------------------------------------------------------------

export async function insertTrustedPeer(
  db: DbHandle,
  peer: Omit<TrustedPeer, "paired_at" | "last_seen_at" | "revoked_at">,
): Promise<void> {
  await db.execute(
    `INSERT INTO trusted_peer (id, peer_id, display_name, public_key, capabilities_json)
     VALUES (?, ?, ?, ?, ?)`,
    [peer.id, peer.peer_id, peer.display_name, peer.public_key, peer.capabilities_json],
  );
}

export async function listTrustedPeers(db: DbHandle): Promise<TrustedPeer[]> {
  return db.select<TrustedPeer>(
    `SELECT * FROM trusted_peer ORDER BY COALESCE(last_seen_at, paired_at) DESC`,
  );
}

export async function revokeTrustedPeer(db: DbHandle, peerId: string): Promise<void> {
  await db.execute(
    `UPDATE trusted_peer SET revoked_at = datetime('now') WHERE peer_id = ?`,
    [peerId],
  );
}

// ---------------------------------------------------------------------------
// TaskTransfer
// ---------------------------------------------------------------------------

export async function insertTaskTransfer(
  db: DbHandle,
  transfer: Omit<TaskTransfer, "started_at" | "completed_at">,
): Promise<void> {
  await db.execute(
    `INSERT INTO task_transfer
       (id, direction, status, source_peer_id, target_peer_id, source_task_id, local_task_id, error, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      transfer.id,
      transfer.direction,
      transfer.status,
      transfer.source_peer_id,
      transfer.target_peer_id,
      transfer.source_task_id,
      transfer.local_task_id,
      transfer.error,
      transfer.payload_json,
    ],
  );
}

export async function listTaskTransfersForItem(
  db: DbHandle,
  itemId: string,
): Promise<TaskTransfer[]> {
  return db.select<TaskTransfer>(
    `SELECT * FROM task_transfer WHERE local_task_id = ? ORDER BY started_at DESC`,
    [itemId],
  );
}

export async function getTaskTransfer(
  db: DbHandle,
  transferId: string,
): Promise<TaskTransfer | null> {
  const rows = await db.select<TaskTransfer>(
    `SELECT * FROM task_transfer WHERE id = ?`,
    [transferId],
  );
  return rows[0] ?? null;
}

export async function markTaskTransferCompleted(
  db: DbHandle,
  transferId: string,
  localTaskId: string,
): Promise<void> {
  await db.execute(
    `UPDATE task_transfer SET status = 'completed', local_task_id = ?, completed_at = datetime('now'), error = NULL WHERE id = ?`,
    [localTaskId, transferId],
  );
}

export async function markTaskTransferRejected(
  db: DbHandle,
  transferId: string,
  error: string,
): Promise<void> {
  await db.execute(
    `UPDATE task_transfer SET status = 'rejected', completed_at = datetime('now'), error = ? WHERE id = ?`,
    [error, transferId],
  );
}

// ---------------------------------------------------------------------------
// TaskTransferProvenance
// ---------------------------------------------------------------------------

export async function insertTaskTransferProvenance(
  db: DbHandle,
  provenance: Omit<TaskTransferProvenance, "imported_at">,
): Promise<void> {
  await db.execute(
    `INSERT INTO task_transfer_provenance
       (pipeline_item_id, source_peer_id, source_task_id, source_machine_task_label)
     VALUES (?, ?, ?, ?)`,
    [
      provenance.pipeline_item_id,
      provenance.source_peer_id,
      provenance.source_task_id,
      provenance.source_machine_task_label,
    ],
  );
}

export async function getTaskTransferProvenance(
  db: DbHandle,
  itemId: string,
): Promise<TaskTransferProvenance | null> {
  const rows = await db.select<TaskTransferProvenance>(
    `SELECT * FROM task_transfer_provenance WHERE pipeline_item_id = ?`,
    [itemId],
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// OperatorEvent
// ---------------------------------------------------------------------------

export async function insertOperatorEvent(
  db: DbHandle,
  eventType: "task_selected" | "app_blur" | "app_focus",
  pipelineItemId: string | null,
  repoId: string | null
): Promise<void> {
  await db.execute(
    "INSERT INTO operator_event (event_type, pipeline_item_id, repo_id) VALUES (?, ?, ?)",
    [eventType, pipelineItemId, repoId]
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getSetting(
  db: DbHandle,
  key: string
): Promise<string | null> {
  const rows = await db.select<Setting>(
    "SELECT * FROM settings WHERE key = ?",
    [key]
  );
  return rows[0]?.value ?? null;
}

export async function setSetting(
  db: DbHandle,
  key: string,
  value: string
): Promise<void> {
  await db.execute(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value]
  );
}
