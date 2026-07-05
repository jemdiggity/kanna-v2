import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetRepoRemoteUrlCacheForTests,
  refreshRepoRemoteMetadata,
} from "./repoRemoteUrl";
import { updateDesktopServerClientHandlersForTests } from "./desktopServerClient";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  updateRepoRemoteMetadata: vi.fn(),
}));

vi.mock("../invoke", () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));

vi.mock("@kanna/db", () => ({
  updateRepoRemoteMetadata: (...args: unknown[]) => mocks.updateRepoRemoteMetadata(...args),
}));

describe("repo remote URL metadata", () => {
  beforeEach(() => {
    __resetRepoRemoteUrlCacheForTests();
    mocks.invoke.mockReset();
    mocks.updateRepoRemoteMetadata.mockReset();
    mocks.updateRepoRemoteMetadata.mockResolvedValue(undefined);
    updateDesktopServerClientHandlersForTests({
      patchRepo: async (repoId, input) => {
        await mocks.updateRepoRemoteMetadata(null, repoId, {
          remote_url: input.remoteUrl ?? null,
          remote_url_hash: input.remoteUrlHash ?? null,
        });
      },
    });
  });

  it("refreshes and persists remote URL metadata explicitly", async () => {
    mocks.invoke.mockResolvedValue("git@github.com:owner/repo.git");

    const metadata = await refreshRepoRemoteMetadata(null as never, {
      id: "repo-1",
      path: "/repo",
    });

    expect(metadata).toEqual({
      remoteUrl: "git@github.com:owner/repo.git",
      remoteUrlHash: "b1cd17c6cfc6f18ca212b7e8ac47cfe7429102823006de2bc18203527bfb711e",
    });
    expect(mocks.invoke).toHaveBeenCalledWith("git_remote_url", { repoPath: "/repo" });
    expect(mocks.updateRepoRemoteMetadata).toHaveBeenCalledWith(null, "repo-1", {
      remote_url: "git@github.com:owner/repo.git",
      remote_url_hash: "b1cd17c6cfc6f18ca212b7e8ac47cfe7429102823006de2bc18203527bfb711e",
    });
  });
});
