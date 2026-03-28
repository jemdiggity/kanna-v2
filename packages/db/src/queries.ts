import type { Repo, PipelineItem, Setting, TaskBlocker } from "./schema.js";

export type DbHandle = {
  execute(query: string, bindValues?: unknown[]): Promise<{ rowsAffected: number }>;
  select<T>(query: string, bindValues?: unknown[]): Promise<T[]>;
};

// ---------------------------------------------------------------------------
// Repo
// ---------------------------------------------------------------------------

export async function listRepos(db: DbHandle): Promise<Repo[]> {
  return db.select<Repo>("SELECT * FROM repo WHERE hidden = 0 ORDER BY last_opened_at DESC");
}

export async function getRepo(db: DbHandle, id: string): Promise<Repo | null> {
  const rows = await db.select<Repo>("SELECT * FROM repo WHERE id = ?", [id]);
  return rows[0] ?? null;
}

export async function insertRepo(
  db: DbHandle,
  repo: Omit<Repo, "created_at" | "last_opened_at" | "hidden">
): Promise<void> {
  await db.execute(
    `INSERT INTO repo (id, path, name, default_branch) VALUES (?, ?, ?, ?)`,
    [repo.id, repo.path, repo.name, repo.default_branch]
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
    "SELECT * FROM pipeline_item WHERE repo_id = ? ORDER BY created_at DESC",
    [repoId]
  );
}

export async function insertPipelineItem(
  db: DbHandle,
  item: Omit<PipelineItem, "created_at" | "updated_at" | "activity_changed_at" | "unread_at" | "pinned" | "pin_order" | "display_name" | "closed_at" | "pipeline" | "stage" | "stage_result" | "tags" | "base_ref" | "claude_session_id"> & { pipeline?: string; stage?: string; tags?: string[]; activity?: PipelineItem["activity"]; display_name?: string | null; base_ref?: string | null }
): Promise<void> {
  const tagsJson = JSON.stringify(item.tags ?? []);
  await db.execute(
    `INSERT INTO pipeline_item
       (id, repo_id, issue_number, issue_title, prompt, pipeline, stage, tags, pr_number, pr_url, branch, agent_type, agent_provider, port_offset, port_env, activity, activity_changed_at, display_name, base_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)`,
    [
      item.id,
      item.repo_id,
      item.issue_number,
      item.issue_title,
      item.prompt,
      item.pipeline ?? "default",
      item.stage ?? "in progress",
      tagsJson,
      item.pr_number,
      item.pr_url,
      item.branch,
      item.agent_type,
      item.agent_provider ?? "claude",
      item.port_offset ?? null,
      item.port_env ?? null,
      item.activity ?? "idle",
      item.display_name ?? null,
      item.base_ref ?? null,
    ]
  );
  await db.execute(
    "INSERT INTO activity_log (pipeline_item_id, activity) VALUES (?, ?)",
    [item.id, item.activity ?? "idle"]
  );
}

export async function updatePipelineItemStage(
  db: DbHandle,
  id: string,
  stage: string
): Promise<void> {
  await db.execute(
    `UPDATE pipeline_item SET stage = ?, updated_at = datetime('now') WHERE id = ?`,
    [stage, id]
  );
}

export async function updatePipelineItemStageResult(
  db: DbHandle,
  id: string,
  result: string
): Promise<void> {
  await db.execute(
    `UPDATE pipeline_item SET stage_result = ?, updated_at = datetime('now') WHERE id = ?`,
    [result, id]
  );
}

export async function clearPipelineItemStageResult(
  db: DbHandle,
  id: string
): Promise<void> {
  await db.execute(
    `UPDATE pipeline_item SET stage_result = NULL, updated_at = datetime('now') WHERE id = ?`,
    [id]
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
  const result = await db.execute(
    `UPDATE pipeline_item SET activity = ?, activity_changed_at = datetime('now')${unreadClause}, updated_at = datetime('now') WHERE id = ? AND activity != ?`,
    [activity, id, activity]
  );
  if (result.rowsAffected === 0) return;
  await db.execute(
    "INSERT INTO activity_log (pipeline_item_id, activity) VALUES (?, ?)",
    [id, activity]
  );
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

export async function updateClaudeSessionId(
  db: DbHandle,
  id: string,
  claudeSessionId: string
): Promise<void> {
  await db.execute(
    "UPDATE pipeline_item SET claude_session_id = ?, updated_at = datetime('now') WHERE id = ?",
    [claudeSessionId, id]
  );
}

export async function closePipelineItem(
  db: DbHandle,
  id: string
): Promise<void> {
  await db.execute(
    "UPDATE pipeline_item SET stage = 'done', closed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
    [id]
  );
}

export async function reopenPipelineItem(
  db: DbHandle,
  id: string
): Promise<void> {
  await db.execute(
    "UPDATE pipeline_item SET closed_at = NULL, updated_at = datetime('now') WHERE id = ?",
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
