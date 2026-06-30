import { describe, expect, it } from "vitest";
import { resolveKdContext } from "../src/context";

describe("resolveKdContext", () => {
  it("derives isolated paths for worktrees", () => {
    const context = resolveKdContext({
      repoRoot: "/repo/.kanna-worktrees/task-abc123",
      homeDir: "/Users/tester",
      env: {
        KANNA_DB_NAME: "shared.db",
        KANNA_DAEMON_DIR: "/tmp/shared-daemon"
      },
      branch: "task-abc123",
      commit: "cafebabe",
      bundleIdentifier: "build.kanna",
      configPorts: {}
    });

    expect(context.isWorktree).toBe(true);
    expect(context.worktreeName).toBe("task-abc123");
    expect(context.env.KANNA_DB_NAME).toBe("kanna-wt-task-abc123.db");
    expect(context.env.KANNA_DAEMON_DIR).toBe("/repo/.kanna-worktrees/task-abc123/.kanna-daemon");
    expect(context.env.CARGO_BUILD_BUILD_DIR).toBe("/repo/.kanna-worktrees/task-abc123/.build/cargo-build");
    expect(context.tmux.session).toBe("kanna-task-abc123");
  });

  it("replaces the legacy shared Rust build cache in worktrees", () => {
    const context = resolveKdContext({
      repoRoot: "/repo/.kanna-worktrees/task-abc123",
      homeDir: "/Users/tester",
      env: {
        CARGO_BUILD_BUILD_DIR: "/Users/tester/Library/Caches/kanna/rust-build"
      },
      branch: "task-abc123",
      commit: "cafebabe",
      bundleIdentifier: "build.kanna",
      configPorts: {}
    });

    expect(context.env.CARGO_BUILD_BUILD_DIR).toBe("/repo/.kanna-worktrees/task-abc123/.build/cargo-build");
  });

  it("honors explicit custom Rust build cache overrides in worktrees", () => {
    const context = resolveKdContext({
      repoRoot: "/repo/.kanna-worktrees/task-abc123",
      homeDir: "/Users/tester",
      env: {
        CARGO_BUILD_BUILD_DIR: "/tmp/custom-rust-build"
      },
      branch: "task-abc123",
      commit: "cafebabe",
      bundleIdentifier: "build.kanna",
      configPorts: {}
    });

    expect(context.env.CARGO_BUILD_BUILD_DIR).toBe("/tmp/custom-rust-build");
  });

  it("honors root checkout DB overrides", () => {
    const context = resolveKdContext({
      repoRoot: "/repo/kanna-v2",
      homeDir: "/Users/tester",
      env: { KANNA_DB_NAME: "dev-root.db" },
      branch: "main",
      commit: "abcdef1",
      bundleIdentifier: "build.kanna",
      configPorts: {}
    });

    expect(context.isWorktree).toBe(false);
    expect(context.env.KANNA_DB_NAME).toBe("dev-root.db");
    expect(context.env.KANNA_DB_PATH).toBe("/Users/tester/Library/Application Support/build.kanna/dev-root.db");
  });

  it("honors explicit DB overrides in worktrees", () => {
    const context = resolveKdContext({
      repoRoot: "/repo/.kanna-worktrees/task-abc123",
      homeDir: "/Users/tester",
      env: {},
      branch: "task-abc123",
      commit: "cafebabe",
      bundleIdentifier: "build.kanna",
      configPorts: {},
      dbOverride: "explicit.db"
    });

    expect(context.env.KANNA_DB_NAME).toBe("explicit.db");
    expect(context.env.KANNA_DB_PATH).toBe("/Users/tester/Library/Application Support/build.kanna/explicit.db");
  });

  it("honors explicit daemon and transfer overrides in worktrees", () => {
    const context = resolveKdContext({
      repoRoot: "/repo/.kanna-worktrees/task-abc123",
      homeDir: "/Users/tester",
      env: {
        KANNA_DAEMON_DIR: "/tmp/inherited-daemon",
        KANNA_TRANSFER_ROOT: "/tmp/inherited-transfer"
      },
      branch: "task-abc123",
      commit: "cafebabe",
      bundleIdentifier: "build.kanna",
      configPorts: {},
      daemonDirOverride: "/tmp/explicit-daemon",
      transferRootOverride: "/tmp/explicit-transfer"
    });

    expect(context.env.KANNA_DAEMON_DIR).toBe("/tmp/explicit-daemon");
    expect(context.env.KANNA_TRANSFER_ROOT).toBe("/tmp/explicit-transfer");
  });
});
