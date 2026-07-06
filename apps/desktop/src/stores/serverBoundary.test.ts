import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

const SRC_ROOT = resolve(__dirname, "..");

const ALLOWED_DB_BOUNDARY_FILES = new Set([
  "stores/db.ts",
  "stores/taskCloseActions.ts",
  "stores/taskBlockedActions.ts",
  "stores/taskItemActions.ts",
]);

function databaseBoundaryViolations(source: string): string[] {
  const violations: string[] = [];
  const databasePackage = ["@kanna", "db"].join("/");

  if (source.includes(databasePackage)) {
    violations.push("imports database package");
  }

  if (/\brequireDb\s*\(\s*\)/.test(source)) {
    violations.push("calls database provider");
  }

  if (/\bdb\s*\.\s*(execute|select)\s*(<[^>]+>)?\s*\(/.test(source)) {
    violations.push("calls raw database method");
  }

  const dbHandleIdentifiers = new Set<string>();
  for (const match of source.matchAll(/\b([A-Za-z_$][\w$]*)\s*:\s*DbHandle\b/g)) {
    dbHandleIdentifiers.add(match[1]);
  }
  for (const identifier of dbHandleIdentifiers) {
    const memberCall = new RegExp(`\\b${identifier}\\s*\\.\\s*(execute|select)\\s*(<[^>]+>)?\\s*\\(`);
    if (memberCall.test(source)) {
      violations.push(`calls ${identifier}.execute/${identifier}.select through DbHandle`);
    }
  }

  return violations;
}

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = resolve(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...listSourceFiles(path));
    } else if (/\.(ts|vue)$/.test(entry)) {
      files.push(path);
    }
  }
  return files;
}

describe("desktop server boundary", () => {
  it("recognizes direct database access shapes without matching unrelated execute calls", () => {
    const requireDbSelect = "await context." + "requireDb" + "()." + "select" + "<Row>('SELECT 1')";
    const dbHandleExecute = "const handle: DbHandle = getHandle(); await handle." + "execute" + "('UPDATE x')";
    const commandExecute = "cmd." + "execute" + "(); command." + "execute" + "();";

    expect(databaseBoundaryViolations(requireDbSelect)).toContain("calls database provider");
    expect(databaseBoundaryViolations(dbHandleExecute)).toContain(
      "calls handle.execute/handle.select through DbHandle",
    );
    expect(databaseBoundaryViolations(commandExecute)).toEqual([]);
  });

  it("keeps direct frontend database access inside documented migration carve-outs", () => {
    const violations: Array<{ file: string; reasons: string[] }> = [];

    for (const file of listSourceFiles(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file);
      if (rel === "stores/serverBoundary.test.ts") continue;
      if (ALLOWED_DB_BOUNDARY_FILES.has(rel)) continue;
      const source = readFileSync(file, "utf8");
      const reasons = databaseBoundaryViolations(source);
      if (reasons.length > 0) {
        violations.push({ file: rel, reasons });
      }
    }

    expect(violations).toEqual([]);
  });
});
