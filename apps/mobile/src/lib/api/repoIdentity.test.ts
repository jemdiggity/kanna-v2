import { describe, expect, it } from "vitest";
import {
  canonicalRepoId,
  canonicalRepoIdForHash,
  mergeRepoSummaries
} from "./repoIdentity";

describe("canonicalRepoId", () => {
  it("uses the remote url hash when present and the local id otherwise", () => {
    expect(canonicalRepoId({ id: "repo-1", remoteUrlHash: "hash-1" })).toBe(
      "git:hash-1"
    );
    expect(canonicalRepoId({ id: "repo-1", remoteUrlHash: null })).toBe(
      "repo-1"
    );
    expect(canonicalRepoId({ id: "repo-1" })).toBe("repo-1");
    expect(canonicalRepoIdForHash("hash-1")).toBe("git:hash-1");
  });
});

describe("mergeRepoSummaries", () => {
  it("collapses the same repository from two machines into one entry", () => {
    expect(
      mergeRepoSummaries([
        { id: "repo-machine-a", name: "kanna", remoteUrlHash: "hash-kanna" },
        { id: "repo-machine-b", name: "kanna", remoteUrlHash: "hash-kanna" }
      ])
    ).toEqual([
      { id: "git:hash-kanna", name: "kanna", remoteUrlHash: "hash-kanna" }
    ]);
  });

  it("keeps repositories with different remotes or no remote separate", () => {
    expect(
      mergeRepoSummaries([
        { id: "repo-a", name: "kanna", remoteUrlHash: "hash-kanna" },
        { id: "repo-b", name: "other", remoteUrlHash: "hash-other" },
        { id: "repo-local", name: "scratch" }
      ])
    ).toEqual([
      { id: "git:hash-kanna", name: "kanna", remoteUrlHash: "hash-kanna" },
      { id: "git:hash-other", name: "other", remoteUrlHash: "hash-other" },
      { id: "repo-local", name: "scratch" }
    ]);
  });

  it("folds hash-less entries whose id is a known member of a hashed group", () => {
    expect(
      mergeRepoSummaries([
        { id: "repo-machine-a", name: "kanna (from task)" },
        { id: "repo-machine-a", name: "kanna", remoteUrlHash: "hash-kanna" }
      ])
    ).toEqual([
      {
        id: "git:hash-kanna",
        name: "kanna (from task)",
        remoteUrlHash: "hash-kanna"
      }
    ]);
  });

  it("groups already-canonical ids with hashed members and keeps input order", () => {
    expect(
      mergeRepoSummaries([
        { id: "git:hash-kanna", name: "kanna" },
        { id: "repo-local", name: "scratch" },
        { id: "repo-machine-b", name: "kanna b", remoteUrlHash: "hash-kanna" }
      ])
    ).toEqual([
      { id: "git:hash-kanna", name: "kanna", remoteUrlHash: "hash-kanna" },
      { id: "repo-local", name: "scratch" }
    ]);
  });
});
