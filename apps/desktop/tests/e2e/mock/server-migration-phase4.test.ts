import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebDriverClient } from "../helpers/webdriver";
import { queryDb } from "../helpers/vue";

describe("server schema ownership", () => {
  const client = new WebDriverClient();

  beforeAll(async () => {
    await client.createSession();
  });

  afterAll(async () => {
    await client.deleteSession();
  });

  it("boots a fresh profile after kanna-server migrates the database", async () => {
    const migrations = await queryDb(
      client,
      "SELECT id FROM schema_migrations WHERE id = ?",
      ["026_stage_run_resume"],
    ) as Array<{ id: string }>;
    expect(migrations).toEqual([{ id: "026_stage_run_resume" }]);

    const tables = await queryDb(
      client,
      `SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('repo', 'pipeline_item', 'stage_run', 'task_blocker')
        ORDER BY name`,
    ) as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual([
      "pipeline_item",
      "repo",
      "stage_run",
      "task_blocker",
    ]);
  });
});
