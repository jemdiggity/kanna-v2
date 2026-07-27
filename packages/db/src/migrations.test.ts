import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

describe("database package migrations", () => {
  it("applies the fresh schema and inserts a linked task action request", async () => {
    const initialSchema = await readFile("src/migrations/001_initial.sql", "utf8");
    const db = new DatabaseSync(":memory:");

    try {
      db.exec("PRAGMA foreign_keys = ON");
      db.exec(initialSchema);
      db.exec(`
        INSERT INTO repo (id, path, name, default_branch)
        VALUES ('repo-1', '/tmp/repo-1', 'Repo One', 'main');
        INSERT INTO pipeline_item (id, repo_id)
        VALUES ('task-1', 'repo-1');
        INSERT INTO stage_run (id, task_id, stage, kind, status)
        VALUES ('run-1', 'task-1', 'in progress', 'main', 'running');
        INSERT INTO task_action_request (
          idempotency_key,
          task_id,
          action,
          request_json,
          successor_run_id,
          state
        )
        VALUES ('request-1', 'task-1', 'request_revision', '{}', 'run-1', 'pending');
      `);

      expect(
        db.prepare(
          `SELECT successor_run_id, phase, owner_id, revision_round,
                  post_delivery_started_at, post_source_run_id,
                  post_source_status, post_source_finished_at
           FROM task_action_request WHERE idempotency_key = ?`,
        ).get("request-1"),
      ).toEqual({
        successor_run_id: "run-1",
        phase: "claimed",
        owner_id: null,
        revision_round: null,
        post_delivery_started_at: null,
        post_source_run_id: null,
        post_source_status: null,
        post_source_finished_at: null,
      });
      expect(db.prepare("SELECT sort_order FROM repo WHERE id = ?").get("repo-1")).toEqual({
        sort_order: 0,
      });
    } finally {
      db.close();
    }
  });

  it("includes the durable pipeline item activity revision", async () => {
    const initialSchema = await readFile("src/migrations/001_initial.sql", "utf8");

    expect(initialSchema).toMatch(
      /CREATE TABLE IF NOT EXISTS pipeline_item \([\s\S]*activity TEXT NOT NULL DEFAULT 'idle',\s*activity_revision INTEGER NOT NULL DEFAULT 0,\s*activity_changed_at TEXT/,
    );
  });
});
