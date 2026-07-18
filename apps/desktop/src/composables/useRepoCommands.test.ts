import { afterEach, describe, expect, it, vi } from "vitest";
import { setDesktopServerClientHandlersForTests } from "../services/desktopServerClient";
import { useRepoCommands } from "./useRepoCommands";

describe("useRepoCommands", () => {
  afterEach(() => setDesktopServerClientHandlersForTests(null));

  it("loads the server-owned command catalog for the selected repo", async () => {
    const fetchRepoCommands = vi.fn(async () => ({
      repoId: "repo-1",
      revision: "catalog-v1",
      commands: [{
        id: "custom:ship",
        label: "Ship",
        description: "Release this repository",
        group: "automation" as const
      }]
    }));
    setDesktopServerClientHandlersForTests({ fetchRepoCommands });
    const { catalog, scan } = useRepoCommands();

    await scan("repo-1");

    expect(fetchRepoCommands).toHaveBeenCalledWith("repo-1");
    expect(catalog.value).toMatchObject({
      repoId: "repo-1",
      revision: "catalog-v1",
      commands: [{ id: "custom:ship" }]
    });
  });
});
