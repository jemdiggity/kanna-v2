import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const docsDevDir = join(repoRoot, "docs", "dev");

const E2E_TEST_DB_COMMAND = "./kd dev up --db kanna-test.db";

function listDocPages(): string[] {
  return readdirSync(docsDevDir).filter((name) => name.endsWith(".md"));
}

function extractLocalLinkTargets(markdown: string): string[] {
  const targets: string[] = [];
  for (const match of markdown.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1].split("#")[0];
    if (!target || target.startsWith("http://") || target.startsWith("https://") || target.startsWith("mailto:")) {
      continue;
    }
    targets.push(target);
  }
  return targets;
}

describe("developer docs", () => {
  it("has the expected docs/dev pages", () => {
    const pages = listDocPages();
    for (const required of ["README.md", "getting-started.md", "architecture.md", "dev-workflow.md", "testing.md", "release.md"]) {
      expect(pages, `docs/dev/${required} is missing`).toContain(required);
    }
  });

  it("only links to files that exist", () => {
    const broken: string[] = [];
    for (const page of listDocPages()) {
      const markdown = readFileSync(join(docsDevDir, page), "utf8");
      for (const target of extractLocalLinkTargets(markdown)) {
        if (!existsSync(resolve(docsDevDir, target))) {
          broken.push(`${page} -> ${target}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it("documents the desktop E2E launch with the explicit test database", () => {
    const testingDoc = readFileSync(join(docsDevDir, "testing.md"), "utf8");
    expect(testingDoc).toContain(E2E_TEST_DB_COMMAND);
  });

  it("matches the command the E2E preload harness demands", () => {
    // The preload refuses to run against a non-test database and prints the
    // canonical launch command; the docs example must stay in lockstep with it.
    const preload = readFileSync(join(repoRoot, "apps", "desktop", "tests", "e2e", "preload.ts"), "utf8");
    expect(preload).toContain(E2E_TEST_DB_COMMAND);
  });
});
