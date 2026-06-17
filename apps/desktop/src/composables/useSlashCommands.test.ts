// @vitest-environment happy-dom

import { ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../invoke", () => ({ invoke: vi.fn() }));

import { invoke } from "../invoke";
import { parseCommandDescription, useSlashCommands } from "./useSlashCommands";

const mockInvoke = vi.mocked(invoke);

function mockFs(files: Record<string, string[]>, contents: Record<string, string>) {
  mockInvoke.mockImplementation((async (command: string, args?: Record<string, unknown>) => {
    if (command === "read_env_var") return "/home/u";
    if (command === "list_dir") {
      const path = args?.path as string;
      if (path in files) return files[path];
      throw new Error(`not a directory: ${path}`);
    }
    if (command === "read_text_file") {
      const path = args?.path as string;
      return contents[path] ?? "";
    }
    throw new Error(`unexpected command ${command}`);
  }) as typeof invoke);
}

describe("parseCommandDescription", () => {
  it("reads description from frontmatter", () => {
    expect(parseCommandDescription("---\ndescription: Review the diff\n---\nbody")).toBe("Review the diff");
  });

  it("falls back to the first prose line, skipping headings", () => {
    expect(parseCommandDescription("# Title\n\nRun the test suite then report.")).toBe(
      "Run the test suite then report.",
    );
  });
});

describe("useSlashCommands", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("scans claude command dirs, with project overriding user, and custom overriding builtins", async () => {
    mockFs(
      {
        "/home/u/.claude/commands": ["review.md", "shared.md", "notes.txt"],
        "/work/tree/.claude/commands": ["commit.md", "shared.md", "compact.md"],
      },
      {
        "/home/u/.claude/commands/review.md": "---\ndescription: Review the branch\n---\n",
        "/home/u/.claude/commands/shared.md": "user version",
        "/work/tree/.claude/commands/commit.md": "Commit and open a PR",
        "/work/tree/.claude/commands/shared.md": "project version",
        "/work/tree/.claude/commands/compact.md": "Custom compact",
      },
    );

    const slash = useSlashCommands(ref("claude"), ref("/work/tree"));
    await slash.reload();

    const names = slash.commands.value.map((c) => c.name);
    // Custom commands present alongside built-ins; `.txt` ignored.
    expect(names).toEqual(expect.arrayContaining(["commit", "review", "shared", "context", "clear"]));
    // Project wins the `shared` conflict (over user).
    expect(slash.commands.value.find((c) => c.name === "shared")?.source).toBe("project");
    // A custom `compact` overrides the built-in of the same name.
    expect(slash.commands.value.find((c) => c.name === "compact")?.source).toBe("project");
    // The built-in `context` is surfaced.
    expect(slash.commands.value.find((c) => c.name === "context")?.source).toBe("builtin");
    expect(slash.commands.value.find((c) => c.name === "review")?.description).toBe("Review the branch");
  });

  it("offers no slash commands for codex (codex exec does not expand them)", async () => {
    mockFs(
      { "/home/u/.codex/prompts": ["plan.md"] },
      { "/home/u/.codex/prompts/plan.md": "Make a plan" },
    );

    const slash = useSlashCommands(ref("codex"), ref(undefined));
    await slash.reload();

    expect(slash.commands.value).toEqual([]);
  });

  it("filters by fuzzy match on the query", async () => {
    mockFs(
      { "/home/u/.claude/commands": ["refactor.md"] },
      {},
    );

    const slash = useSlashCommands(ref("claude"), ref(undefined));
    await slash.reload();

    // "re" matches the custom refactor plus built-ins like review.
    expect(slash.filter("re").map((c) => c.name)).toEqual(expect.arrayContaining(["refactor", "review"]));
    expect(slash.filter("re").map((c) => c.name)).not.toContain("compact");
    // Empty query returns everything (custom + built-ins).
    expect(slash.filter("").length).toBe(slash.commands.value.length);
    expect(slash.filter("").length).toBeGreaterThan(1);
  });
});
