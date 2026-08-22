import { describe, expect, it } from "vitest";
import {
  appendDirectoryPage,
  backExplorer,
  explorerFilterQuery,
  forwardExplorer,
  initialExplorerNavigation,
  navigateExplorer,
  parentExplorerPath
} from "./repoExplorerState";

describe("repository explorer navigation and filtering", () => {
  it("navigates back one task-worktree directory at a time", () => {
    expect(parentExplorerPath("apps/mobile/src")).toBe("apps/mobile");
    expect(parentExplorerPath("apps")).toBe("");
  });

  it("walks back and forward through directories and files", () => {
    let navigation = initialExplorerNavigation();
    navigation = navigateExplorer(navigation, {
      path: "apps/mobile",
      filePath: null
    });
    navigation = navigateExplorer(navigation, {
      path: "apps/mobile",
      filePath: "apps/mobile/package.json"
    });

    navigation = backExplorer(navigation);
    expect(navigation.current).toEqual({ path: "apps/mobile", filePath: null });
    navigation = backExplorer(navigation);
    expect(navigation.current).toEqual({ path: "apps", filePath: null });
    navigation = forwardExplorer(navigation);
    expect(navigation.current).toEqual({ path: "apps/mobile", filePath: null });
    navigation = forwardExplorer(navigation);
    expect(navigation.current).toEqual({
      path: "apps/mobile",
      filePath: "apps/mobile/package.json"
    });
  });

  it("truncates forward history after explicit navigation", () => {
    let navigation = navigateExplorer(initialExplorerNavigation(), {
      path: "src",
      filePath: null
    });
    navigation = backExplorer(navigation);
    expect(navigation.forward).toHaveLength(1);

    navigation = navigateExplorer(navigation, {
      path: "docs",
      filePath: null
    });
    expect(navigation.forward).toEqual([]);
    expect(forwardExplorer(navigation)).toBe(navigation);
  });

  it("does not create history when backing out of the root", () => {
    const navigation = initialExplorerNavigation();
    expect(backExplorer(navigation)).toBe(navigation);
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
