import { describe, expect, it } from "vitest";
import {
  buildTaskDiffDocument,
  parseTaskDiffPatch
} from "./buildTaskDiffDocument";

const SAMPLE_PATCH = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
 const value = 1;
-const removed = 2;
+const added = 3;
+const extra = 4;
diff --git a/docs/new.md b/docs/new.md
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/docs/new.md
@@ -0,0 +1,1 @@
+# New
`;

describe("parseTaskDiffPatch", () => {
  it("splits the patch into per-file sections with add/delete counts", () => {
    const sections = parseTaskDiffPatch(SAMPLE_PATCH);

    expect(sections.map((section) => section.path)).toEqual([
      "src/app.ts",
      "docs/new.md"
    ]);
    expect(sections[0]).toMatchObject({ additions: 2, deletions: 1 });
    expect(sections[1]).toMatchObject({ additions: 1, deletions: 0 });
  });

  it("classifies hunk, meta, add, delete, and context lines", () => {
    const [section] = parseTaskDiffPatch(SAMPLE_PATCH);

    const kinds = new Map(section.lines.map((line) => [line.text, line.kind]));
    expect(kinds.get("@@ -1,3 +1,4 @@")).toBe("hunk");
    expect(kinds.get("--- a/src/app.ts")).toBe("meta");
    expect(kinds.get("+++ b/src/app.ts")).toBe("meta");
    expect(kinds.get("+const added = 3;")).toBe("add");
    expect(kinds.get("-const removed = 2;")).toBe("del");
    expect(kinds.get(" const value = 1;")).toBe("context");
  });

  it("reads quoted file paths from the git header", () => {
    const sections = parseTaskDiffPatch(
      'diff --git "a/docs/spec one.md" "b/docs/spec one.md"\n@@ -1 +1 @@\n-a\n+b\n'
    );

    expect(sections[0]?.path).toBe("docs/spec one.md");
  });

  it("returns no sections for an empty patch", () => {
    expect(parseTaskDiffPatch("")).toEqual([]);
  });
});

describe("buildTaskDiffDocument", () => {
  it("renders file sections with escaped content and stats", () => {
    const document = buildTaskDiffDocument({
      patch: `diff --git a/a.html b/a.html\n@@ -1 +1 @@\n-<b>old</b>\n+<b>new</b>\n`,
      baseRef: "main",
      truncated: false
    });

    expect(document).toContain("1 changed file vs main");
    expect(document).toContain("a.html");
    expect(document).toContain("+&lt;b&gt;new&lt;/b&gt;");
    expect(document).toContain("-&lt;b&gt;old&lt;/b&gt;");
    expect(document).not.toContain("<b>new</b>");
    expect(document).toContain(`<span class="stat-add">+1</span>`);
    expect(document).toContain(`<span class="stat-del">−1</span>`);
  });

  it("escapes the base ref", () => {
    const document = buildTaskDiffDocument({
      patch: "",
      baseRef: "<script>",
      truncated: false
    });

    expect(document).toContain("&lt;script&gt;");
    expect(document).not.toContain("compared to <script>");
  });

  it("shows an empty state when there are no changes", () => {
    const document = buildTaskDiffDocument({
      patch: "",
      baseRef: "main",
      truncated: false
    });

    expect(document).toContain("No changes compared to main.");
  });

  it("shows a truncation notice for oversized diffs", () => {
    const document = buildTaskDiffDocument({
      patch: SAMPLE_PATCH,
      baseRef: null,
      truncated: true
    });

    expect(document).toContain("Diff is too large to display fully");
    expect(document).toContain("2 changed files");
  });

  it("locks the document down with a strict CSP and no scripts", () => {
    const document = buildTaskDiffDocument({
      patch: SAMPLE_PATCH,
      baseRef: "main",
      truncated: false
    });

    expect(document).toContain("Content-Security-Policy");
    expect(document).toContain("default-src 'none'");
    expect(document).not.toContain("<script");
  });
});
