import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("database package migrations", () => {
  it("includes repo sort_order in the initial schema", async () => {
    const initialSchema = await readFile("src/migrations/001_initial.sql", "utf8");

    expect(initialSchema).toMatch(/CREATE TABLE IF NOT EXISTS repo \([\s\S]*sort_order INTEGER NOT NULL DEFAULT 0/);
  });

  it("includes the durable pipeline item activity revision", async () => {
    const initialSchema = await readFile("src/migrations/001_initial.sql", "utf8");

    expect(initialSchema).toMatch(
      /CREATE TABLE IF NOT EXISTS pipeline_item \([\s\S]*activity TEXT NOT NULL DEFAULT 'idle',\s*activity_revision INTEGER NOT NULL DEFAULT 0,/,
    );
  });

  it("includes the durable pipeline item blocker revision", async () => {
    const initialSchema = await readFile("src/migrations/001_initial.sql", "utf8");

    expect(initialSchema).toMatch(
      /activity_revision INTEGER NOT NULL DEFAULT 0,\s*blocker_revision INTEGER NOT NULL DEFAULT 0,/,
    );
  });
});
