import type { Repo, PipelineItem, Setting } from "./schema.js";

export type DbHandle = {
  execute(query: string, bindValues?: unknown[]): Promise<{ rowsAffected: number }>;
  select<T>(query: string, bindValues?: unknown[]): Promise<T[]>;
};

// ---------------------------------------------------------------------------
// Repo
// ---------------------------------------------------------------------------

export async function listRepos(db: DbHandle): Promise<Repo[]> {
  return db.select<Repo>("SELECT * FROM repo ORDER BY last_opened_at DESC");
}

export async function getRepo(db: DbHandle, id: string): Promise<Repo | null> {
  const rows = await db.select<Repo>("SELECT * FROM repo WHERE id = ?", [id]);
  return rows[0] ?? null;
}

export async function insertRepo(
  db: DbHandle,
  repo: Omit<Repo, "created_at" | "last_opened_at">
): Promise<void> {
  await db.execute(
    `INSERT INTO repo (id, path, name, default_branch) VALUES (?, ?, ?, ?)`,
    [repo.id, repo.path, repo.name, repo.default_branch]
  );
}

export async function deleteRepo(db: DbHandle, id: string): Promise<void> {
  await db.execute("DELETE FROM repo WHERE id = ?", [id]);
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
  item: Omit<PipelineItem, "created_at" | "updated_at" | "activity_changed_at"> & { activity?: PipelineItem["activity"] }
): Promise<void> {
  await db.execute(
    `INSERT INTO pipeline_item
       (id, repo_id, issue_number, issue_title, prompt, stage, pr_number, pr_url, branch, agent_type, port_offset, activity, activity_changed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    [
      item.id,
      item.repo_id,
      item.issue_number,
      item.issue_title,
      item.prompt,
      item.stage,
      item.pr_number,
      item.pr_url,
      item.branch,
      item.agent_type,
      item.port_offset ?? null,
      item.activity ?? "idle",
    ]
  );
}

export async function updatePipelineItemStage(
  db: DbHandle,
  id: string,
  stage: string
): Promise<void> {
  await db.execute(
    "UPDATE pipeline_item SET stage = ?, updated_at = datetime('now') WHERE id = ?",
    [stage, id]
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
  await db.execute(
    "UPDATE pipeline_item SET activity = ?, activity_changed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
    [activity, id]
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
