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
      platform: "darwin",
      configPorts: {}
    });

    expect(context.env.KANNA_DB_ISOLATED).toBe("1");
    expect(context.isWorktree).toBe(true);
    expect(context.worktreeName).toBe("task-abc123");
    expect(context.env.KANNA_BUILD_TASK_ID).toBe("abc123");
    expect(context.env.KANNA_DB_NAME).toBe("kanna-wt-task-abc123.db");
    expect(context.env.KANNA_DAEMON_DIR).toBe("/repo/.kanna-worktrees/task-abc123/.kanna-daemon");
    expect(context.env.CARGO_BUILD_BUILD_DIR).toBe("/repo/.kanna-worktrees/task-abc123/.build/cargo-build");
    expect(context.tmux.session).toBe("kanna-task-abc123");
  });

  it("derives the durable task id from numbered worktree names", () => {
    const context = resolveKdContext({
      repoRoot: "/repo/.kanna-worktrees/task-37ec6039-5",
      homeDir: "/Users/tester",
      env: {},
      branch: "task-37ec6039-5",
      commit: "cafebabe",
      bundleIdentifier: "build.kanna",
      platform: "darwin",
      configPorts: {}
    });

    expect(context.env.KANNA_BUILD_TASK_ID).toBe("37ec6039");
  });

  it("uses the inherited task id when present", () => {
    const context = resolveKdContext({
      repoRoot: "/repo/.kanna-worktrees/task-37ec6039-5",
      homeDir: "/Users/tester",
      env: { KANNA_TASK_ID: "durable-from-session" },
      branch: "task-37ec6039-5",
      commit: "cafebabe",
      bundleIdentifier: "build.kanna",
      platform: "darwin",
      configPorts: {}
    });

    expect(context.env.KANNA_BUILD_TASK_ID).toBe("durable-from-session");
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
      platform: "darwin",
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
      platform: "darwin",
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
      platform: "darwin",
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
      platform: "darwin",
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
      platform: "darwin",
      configPorts: {},
      daemonDirOverride: "/tmp/explicit-daemon",
      transferRootOverride: "/tmp/explicit-transfer"
    });

    expect(context.env.KANNA_DAEMON_DIR).toBe("/tmp/explicit-daemon");
    expect(context.env.KANNA_TRANSFER_ROOT).toBe("/tmp/explicit-transfer");
  });
  describe("on Linux", () => {
    const base = {
      repoRoot: "/repo/kanna-v2",
      homeDir: "/home/tester",
      branch: "main",
      commit: "abcdef1",
      bundleIdentifier: "build.kanna",
      platform: "linux" as const,
      configPorts: {}
    };

    // These must agree with `app_support_dir_for_home` in
    // crates/runtime-defaults and with `dirs::data_dir()`, which is how
    // kanna-server resolves the same directory.
    it("puts application data under the XDG data directory", () => {
      const context = resolveKdContext({ ...base, env: {} });

      expect(context.env.KANNA_DB_PATH).toBe("/home/tester/.local/share/build.kanna/kanna-v2.db");
      expect(context.env.KANNA_DAEMON_DIR).toBe("/home/tester/.local/share/Kanna");
      expect(context.env.KANNA_TRANSFER_ROOT).toBe("/home/tester/.local/share/build.kanna/transfer");
    });

    it("honors an absolute XDG_DATA_HOME and ignores a relative one", () => {
      const configured = resolveKdContext({ ...base, env: { XDG_DATA_HOME: "/xdg/data" } });
      expect(configured.env.KANNA_DAEMON_DIR).toBe("/xdg/data/Kanna");

      const relative = resolveKdContext({ ...base, env: { XDG_DATA_HOME: "relative/data" } });
      expect(relative.env.KANNA_DAEMON_DIR).toBe("/home/tester/.local/share/Kanna");
    });

    it("replaces the legacy shared Rust build cache from the XDG cache directory", () => {
      const context = resolveKdContext({
        ...base,
        repoRoot: "/repo/.kanna-worktrees/task-abc123",
        branch: "task-abc123",
        env: { CARGO_BUILD_BUILD_DIR: "/home/tester/.cache/kanna/rust-build" }
      });

      expect(context.env.CARGO_BUILD_BUILD_DIR).toBe(
        "/repo/.kanna-worktrees/task-abc123/.build/cargo-build"
      );
    });

    it("keeps worktree-relative paths platform-independent", () => {
      const context = resolveKdContext({
        ...base,
        repoRoot: "/repo/.kanna-worktrees/task-abc123",
        branch: "task-abc123",
        env: {}
      });

      expect(context.env.KANNA_DAEMON_DIR).toBe("/repo/.kanna-worktrees/task-abc123/.kanna-daemon");
      expect(context.env.KANNA_DB_PATH).toBe(
        "/home/tester/.local/share/build.kanna/kanna-wt-task-abc123.db"
      );
    });
  });
});
