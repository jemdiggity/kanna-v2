import { describe, it, expect } from "vitest";
import { layoutCommitGraph, type GraphCommit } from "../commitGraph";

describe("layoutCommitGraph", () => {
  it("returns empty output for empty input", () => {
    const result = layoutCommitGraph([]);
    expect(result.commits).toEqual([]);
    expect(result.branches).toEqual([]);
    expect(result.curves).toEqual([]);
  });

  it("assigns single column for linear history", () => {
    const commits: GraphCommit[] = [
      { hash: "c", short_hash: "c", message: "third", author: "A", timestamp: 3, parents: ["b"] },
      { hash: "b", short_hash: "b", message: "second", author: "A", timestamp: 2, parents: ["a"] },
      { hash: "a", short_hash: "a", message: "first", author: "A", timestamp: 1, parents: [] },
    ];
    const result = layoutCommitGraph(commits);
    expect(result.commits).toHaveLength(3);
    expect(result.commits.every((c) => c.x === 0)).toBe(true);
    expect(result.commits.map((c) => c.y)).toEqual([0, 1, 2]);
    expect(result.branches.length).toBeGreaterThanOrEqual(1);
    expect(result.branches.every((b) => b.column === 0)).toBe(true);
    expect(result.curves).toEqual([]);
  });

  it("assigns separate columns for branches", () => {
    const commits: GraphCommit[] = [
      { hash: "d", short_hash: "d", message: "merge", author: "A", timestamp: 4, parents: ["b", "c"] },
      { hash: "c", short_hash: "c", message: "feat work", author: "A", timestamp: 3, parents: ["b"] },
      { hash: "b", short_hash: "b", message: "second", author: "A", timestamp: 2, parents: ["a"] },
      { hash: "a", short_hash: "a", message: "first", author: "A", timestamp: 1, parents: [] },
    ];
    const result = layoutCommitGraph(commits);
    expect(result.commits).toHaveLength(4);
    const dCommit = result.commits.find((c) => c.hash === "d")!;
    const bCommit = result.commits.find((c) => c.hash === "b")!;
    expect(dCommit.x).toBe(bCommit.x);
    const cCommit = result.commits.find((c) => c.hash === "c")!;
    expect(cCommit.x).not.toBe(bCommit.x);
    expect(result.curves.length).toBeGreaterThan(0);
  });

  it("assigns colors from the palette", () => {
    const commits: GraphCommit[] = [
      { hash: "b", short_hash: "b", message: "second", author: "A", timestamp: 2, parents: ["a"] },
      { hash: "a", short_hash: "a", message: "first", author: "A", timestamp: 1, parents: [] },
    ];
    const result = layoutCommitGraph(commits);
    expect(result.commits.every((c) => typeof c.color === "string" && c.color.startsWith("#"))).toBe(true);
  });

  it("handles single commit (root with no parents)", () => {
    const commits: GraphCommit[] = [
      { hash: "a", short_hash: "a", message: "init", author: "A", timestamp: 1, parents: [] },
    ];
    const result = layoutCommitGraph(commits);
    expect(result.commits).toHaveLength(1);
    expect(result.commits[0].x).toBe(0);
    expect(result.commits[0].y).toBe(0);
  });
});
