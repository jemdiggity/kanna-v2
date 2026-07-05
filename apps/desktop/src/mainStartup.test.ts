import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("desktop startup ordering", () => {
  it("loads and migrates the frontend-owned database before waiting for kanna-server readiness", () => {
    const source = readFileSync(resolve(__dirname, "main.ts"), "utf8");

    const loadDatabaseIndex = source.indexOf("await loadDatabase()");
    const runMigrationsIndex = source.indexOf("await runMigrations(db)");
    const waitForMobileServerIndex = source.indexOf('"wait_for_mobile_server_ready"');

    expect(loadDatabaseIndex).toBeGreaterThanOrEqual(0);
    expect(runMigrationsIndex).toBeGreaterThanOrEqual(0);
    expect(waitForMobileServerIndex).toBeGreaterThanOrEqual(0);
    expect(loadDatabaseIndex).toBeLessThan(waitForMobileServerIndex);
    expect(runMigrationsIndex).toBeLessThan(waitForMobileServerIndex);
  });
});
