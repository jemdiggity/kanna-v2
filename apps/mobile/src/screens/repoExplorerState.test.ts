import { describe, expect, it } from "vitest";
import {
  appendDirectoryPage,
  explorerFilterQuery,
  parentExplorerPath
} from "./repoExplorerState";

describe("repository explorer navigation and filtering", () => {
  it("navigates back one task-worktree directory at a time", () => {
    expect(parentExplorerPath("apps/mobile/src")).toBe("apps/mobile");
    expect(parentExplorerPath("apps")).toBe("");
  });

  it("normalizes the server-side folder filter", () => {
    expect(explorerFilterQuery("  controller  ")).toBe("controller");
  });

  it("appends paged directory results without duplicate rows", () => {
    const file = { name: "a.ts", path: "src/a.ts", isDir: false };
    const folder = { name: "lib", path: "src/lib", isDir: true };
    expect(appendDirectoryPage([file], [file, folder])).toEqual([file, folder]);
  });
});
