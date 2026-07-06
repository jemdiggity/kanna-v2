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
  it("keeps direct frontend database access inside documented migration carve-outs", () => {
    const databasePackage = ["@kanna", "db"].join("/");
    const rawSelectOrExecute = new RegExp(["db", "\\.", "(execute|select)"].join(""));
    const violations: string[] = [];

    for (const file of listSourceFiles(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file);
      if (ALLOWED_DB_BOUNDARY_FILES.has(rel)) continue;
      const source = readFileSync(file, "utf8");
      if (source.includes(databasePackage) || rawSelectOrExecute.test(source)) {
        violations.push(rel);
      }
    }

    expect(violations).toEqual([]);
  });
});
