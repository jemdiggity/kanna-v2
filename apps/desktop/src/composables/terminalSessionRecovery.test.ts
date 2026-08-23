import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  shouldDelayConnectUntilAfterInitialLayout,
  formatAttachFailureMessage,
  getRespawnToastKey,
  getReconnectResizeDelayMs,
  getShellTerminalEnv,
  getTaskTerminalEnv,
  getTerminalRecoveryMode,
  isDaemonHandoffFailure,
  getReconnectRedrawPolicy,
  getReconnectKeyboardPush,
  shouldRespawnAfterAttachFailure,
  shouldEnableKittyKeyboard,
  shouldPushKittyKeyboardOnFreshAttach,
  shouldResetTerminalForSnapshot,
  shouldResetTerminalOnReconnect,
  shouldRunTerminalDispose,
  shouldSupportKittyKeyboard,
  shouldSkipReconnect,
  shouldForceDoubleResizeOnReconnect,
  shouldReattachOnDaemonReady,
  shouldRestoreRecoveryState,
  buildTaskShellCommand,
} from "./terminalSessionRecovery";
import { AppError } from "../appError";

describe("getTerminalRecoveryMode", () => {
  const spawnFn = async () => {};

  it("uses attach-only recovery for task PTY terminals", () => {
    expect(
      getTerminalRecoveryMode(
        { cwd: "/tmp/task", prompt: "do work", spawnFn },
        { agentProvider: "claude", worktreePath: "/tmp/task" },
      )
    ).toBe("attach-only");
  });

  it("uses spawn-on-missing recovery for shell terminals", () => {
    expect(
      getTerminalRecoveryMode(
        { cwd: "/tmp/repo", prompt: "", spawnFn },
        undefined,
      )
    ).toBe("spawn-on-missing");
  });
});

describe("formatAttachFailureMessage", () => {
  it("surfaces a visible reconnect failure for task terminals", () => {
    const message = formatAttachFailureMessage("session not found");
    expect(message).toContain("Failed to reconnect");
    expect(message).toContain("session not found");
  });
});

describe("isDaemonHandoffFailure", () => {
  it("recognizes explicit daemon handoff loss errors", () => {
    expect(
      isDaemonHandoffFailure(
        new AppError(
          "session lost during daemon handoff: failed to receive PTY fd",
          "handoff_lost",
        ),
      )
    ).toBe(true);
  });

  it("ignores generic attach failures", () => {
    expect(isDaemonHandoffFailure(new AppError("session not found: abc123"))).toBe(false);
  });

  it("recognizes structured daemon handoff errors", () => {
    expect(
      isDaemonHandoffFailure({ message: "attach failed", code: "handoff_lost" }),
    ).toBe(true);
  });
});

describe("shouldRespawnAfterAttachFailure", () => {
  const spawnFn = async () => {};

  it("respawns task terminals after explicit daemon handoff loss", () => {
    expect(
      shouldRespawnAfterAttachFailure(
        new AppError(
          "session lost during daemon handoff: failed to receive PTY fd",
          "handoff_lost",
        ),
        false,
        false,
        { cwd: "/tmp/task", prompt: "do work", spawnFn },
        { agentProvider: "claude", worktreePath: "/tmp/task" },
      )
    ).toBe(true);
  });

  it("does not respawn task terminals on the first attach when the session is still being created", () => {
    expect(
      shouldRespawnAfterAttachFailure(
        new AppError("session not found: task-1", "session_not_found"),
        false,
        false,
        { cwd: "/tmp/task", prompt: "do work", spawnFn },
        { agentProvider: "claude", worktreePath: "/tmp/task" },
      )
    ).toBe(false);
  });

  it("respawns task terminals when scrollback exists but the PTY is gone", () => {
    expect(
      shouldRespawnAfterAttachFailure(
        new AppError("attach failed", "session_not_found"),
        false,
        true,
        { cwd: "/tmp/task", prompt: "do work", spawnFn },
        { agentProvider: "claude", worktreePath: "/tmp/task" },
      )
    ).toBe(true);
  });

  it("respawns task terminals when a previously attached live session disappears", () => {
    expect(
      shouldRespawnAfterAttachFailure(
        new AppError("session not found: task-1", "session_not_found"),
        true,
        false,
        { cwd: "/tmp/task", prompt: "do work", spawnFn },
        { agentProvider: "claude", worktreePath: "/tmp/task" },
      )
    ).toBe(true);
  });

  it("does not respawn shell terminals from attach failure fallback", () => {
    expect(
      shouldRespawnAfterAttachFailure(
        new AppError(
          "session lost during daemon handoff: failed to receive PTY fd",
          "handoff_lost",
        ),
        true,
        false,
        { cwd: "/tmp/repo", prompt: "", spawnFn },
        undefined,
      )
    ).toBe(false);
  });
});

describe("getRespawnToastKey", () => {
  it("uses restart-specific copy for explicit daemon handoff loss", () => {
    expect(
      getRespawnToastKey(
        new AppError(
          "session lost during daemon handoff: failed to receive PTY fd",
          "handoff_lost",
        ),
        false,
      ),
    ).toBe("toasts.daemonHandoffRespawned");
  });

  it("uses generic copy when a previously attached session is simply missing", () => {
    expect(getRespawnToastKey(new AppError("attach failed", "session_not_found"), false)).toBe("toasts.sessionRespawned");
  });

  it("keeps the scrollback variant for generic respawns", () => {
    expect(getRespawnToastKey(new AppError("session not found: task-1", "session_not_found"), true)).toBe(
      "toasts.sessionRespawnedWithScrollback",
    );
  });
});

describe("shouldReattachOnDaemonReady", () => {
  const spawnFn = async () => {};

  it("re-attaches mounted task PTY terminals after daemon restart", () => {
    expect(
      shouldReattachOnDaemonReady(
        { cwd: "/tmp/task", prompt: "do work", spawnFn },
        { agentProvider: "copilot", worktreePath: "/tmp/task" },
      )
    ).toBe(true);
  });

  it("does not re-attach shell terminals after daemon restart", () => {
    expect(
      shouldReattachOnDaemonReady(
        { cwd: "/tmp/repo", prompt: "", spawnFn },
        undefined,
      )
    ).toBe(true);
  });
});

describe("shouldForceDoubleResizeOnReconnect", () => {
  it("forces double resize churn for Claude reconnects", () => {
    expect(shouldForceDoubleResizeOnReconnect({ agentProvider: "claude" })).toBe(true);
  });

  it("does not force double resize churn for Codex reconnects", () => {
    expect(shouldForceDoubleResizeOnReconnect({ agentProvider: "codex" })).toBe(false);
  });

  it("defaults to no forced double resize for other providers", () => {
    expect(shouldForceDoubleResizeOnReconnect({ agentProvider: "copilot" })).toBe(false);
    expect(shouldForceDoubleResizeOnReconnect()).toBe(false);
  });
});

describe("getReconnectResizeDelayMs", () => {
  it("does not delay reconnect resize churn for Codex", () => {
    expect(getReconnectResizeDelayMs({ agentProvider: "codex" })).toBe(0);
  });

  it("does not delay reconnect resize churn for other providers", () => {
    expect(getReconnectResizeDelayMs({ agentProvider: "claude" })).toBe(0);
    expect(getReconnectResizeDelayMs({ agentProvider: "copilot" })).toBe(0);
    expect(getReconnectResizeDelayMs()).toBe(0);
  });
});

describe("shouldSkipReconnect", () => {
  it("skips reconnect when an attach is already in flight", () => {
    expect(shouldSkipReconnect(true, false)).toBe(true);
  });

  it("skips reconnect for already attached task terminals", () => {
    expect(shouldSkipReconnect(false, true)).toBe(true);
  });

  it("allows reconnect when not attached and no attach is in flight", () => {
    expect(shouldSkipReconnect(false, false)).toBe(false);
  });
});

describe("shouldDelayConnectUntilAfterInitialLayout", () => {
  const spawnFn = async () => {};

  it("waits for initial layout before connecting task PTY terminals", () => {
    expect(
      shouldDelayConnectUntilAfterInitialLayout(
        { cwd: "/tmp/task", prompt: "do work", spawnFn },
        { agentProvider: "claude", worktreePath: "/tmp/task" },
      )
    ).toBe(true);
  });

  it("does not delay shell terminal connection", () => {
    expect(
      shouldDelayConnectUntilAfterInitialLayout(
        { cwd: "/tmp/repo", prompt: "", spawnFn },
        undefined,
      )
    ).toBe(false);
  });
});

describe("shouldRestoreRecoveryState", () => {
  it("restores cached state for task terminals", () => {
    expect(
      shouldRestoreRecoveryState(
        { cwd: "/tmp/task", prompt: "do work", spawnFn: async () => {} },
        { agentProvider: "claude", worktreePath: "/tmp/task" },
      ),
    ).toBe(true);
  });

  it("restores cached state for shell terminals too", () => {
    expect(
      shouldRestoreRecoveryState(
        { cwd: "/tmp/repo", prompt: "", spawnFn: async () => {} },
        undefined,
      ),
    ).toBe(true);
  });
});

describe("shouldRunTerminalDispose", () => {
  it("runs disposal only once per terminal instance", () => {
    expect(shouldRunTerminalDispose(false)).toBe(true);
    expect(shouldRunTerminalDispose(true)).toBe(false);
  });
});

describe("shouldEnableKittyKeyboard", () => {
  it("enables kitty keyboard only for Claude task terminals", () => {
    expect(shouldEnableKittyKeyboard({ agentProvider: "claude" })).toBe(true);
    expect(shouldEnableKittyKeyboard({ agentProvider: "copilot" })).toBe(false);
  });

  it("disables kitty keyboard for Copilot, Codex, and unknown providers", () => {
    expect(shouldEnableKittyKeyboard({ agentProvider: "copilot" })).toBe(false);
    expect(shouldEnableKittyKeyboard({ agentProvider: "codex" })).toBe(false);
    expect(shouldEnableKittyKeyboard()).toBe(false);
  });
});

describe("shouldSupportKittyKeyboard", () => {
  it("enables kitty keyboard protocol support for all agent task terminals", () => {
    expect(shouldSupportKittyKeyboard({ agentProvider: "claude" })).toBe(true);
    expect(shouldSupportKittyKeyboard({ agentProvider: "copilot" })).toBe(true);
    expect(shouldSupportKittyKeyboard({ agentProvider: "codex" })).toBe(true);
  });

  it("disables kitty keyboard protocol support when no provider is set", () => {
    expect(shouldSupportKittyKeyboard()).toBe(false);
  });
});

describe("shouldPushKittyKeyboardOnFreshAttach", () => {
  it("does not push kitty keyboard mode for any provider", () => {
    expect(shouldPushKittyKeyboardOnFreshAttach({ agentProvider: "claude" })).toBe(false);
    expect(shouldPushKittyKeyboardOnFreshAttach({ agentProvider: "copilot" })).toBe(false);
    expect(shouldPushKittyKeyboardOnFreshAttach({ agentProvider: "codex" })).toBe(false);
    expect(shouldPushKittyKeyboardOnFreshAttach()).toBe(false);
  });
});

describe("shouldResetTerminalOnReconnect", () => {
  it("keeps reset behavior for Claude and Copilot reconnects", () => {
    expect(shouldResetTerminalOnReconnect({ agentProvider: "claude" })).toBe(true);
    expect(shouldResetTerminalOnReconnect({ agentProvider: "copilot" })).toBe(true);
  });

  it("avoids resetting xterm state for Codex reconnects", () => {
    expect(shouldResetTerminalOnReconnect({ agentProvider: "codex" })).toBe(false);
  });
});

describe("shouldResetTerminalForSnapshot", () => {
  it("always resets for a respawned session id, Codex included", () => {
    expect(
      shouldResetTerminalForSnapshot({
        preserveRecoveredScrollback: false,
        sessionRespawned: true,
        agentProvider: "codex",
      }),
    ).toBe(true);
    expect(
      shouldResetTerminalForSnapshot({
        preserveRecoveredScrollback: false,
        sessionRespawned: true,
        agentProvider: "claude",
      }),
    ).toBe(true);
  });

  it("keeps the provider-specific behavior on an ordinary reconnect", () => {
    expect(
      shouldResetTerminalForSnapshot({
        preserveRecoveredScrollback: false,
        sessionRespawned: false,
        agentProvider: "codex",
      }),
    ).toBe(false);
    expect(
      shouldResetTerminalForSnapshot({
        preserveRecoveredScrollback: false,
        sessionRespawned: false,
        agentProvider: "claude",
      }),
    ).toBe(true);
  });

  it("never resets over a recovered-scrollback restore", () => {
    expect(
      shouldResetTerminalForSnapshot({
        preserveRecoveredScrollback: true,
        sessionRespawned: true,
        agentProvider: "claude",
      }),
    ).toBe(false);
  });
});

describe("getReconnectKeyboardPush", () => {
  it("does not push keyboard mode on reconnect for any provider", () => {
    expect(getReconnectKeyboardPush({ agentProvider: "claude", kittyKeyboard: true })).toBe(null);
    expect(getReconnectKeyboardPush({ agentProvider: "copilot", kittyKeyboard: true })).toBe(null);
    expect(getReconnectKeyboardPush({ agentProvider: "copilot", kittyKeyboard: false })).toBe(null);
    expect(getReconnectKeyboardPush({ agentProvider: "codex" })).toBe(null);
    expect(getReconnectKeyboardPush()).toBe(null);
  });
});

describe("getTaskTerminalEnv", () => {
  it("uses a safe truecolor xterm environment for Codex", () => {
    expect(getTaskTerminalEnv("codex")).toEqual({
      COLORTERM: "truecolor",
      TERM: "xterm-256color",
      TERM_PROGRAM: "kanna",
    });
  });

  it("uses the same safe terminal identity for other providers", () => {
    expect(getTaskTerminalEnv("claude")).toEqual({
      COLORTERM: "truecolor",
      TERM: "xterm-256color",
      TERM_PROGRAM: "kanna",
    });
    expect(getTaskTerminalEnv("copilot")).toEqual({
      COLORTERM: "truecolor",
      TERM: "xterm-256color",
      TERM_PROGRAM: "kanna",
    });
  });
});

describe("getShellTerminalEnv", () => {
  it("uses the same safe terminal identity for shell sessions", () => {
    expect(getShellTerminalEnv()).toEqual({
      COLORTERM: "truecolor",
      TERM: "xterm-256color",
      TERM_PROGRAM: "kanna",
    });
  });
});

describe("buildTaskShellCommand", () => {
  it("prepends the bundled kanna-cli directory before running the agent", () => {
    const command = buildTaskShellCommand("claude 'merge it'", [], {
      kannaCliPath: "/Applications/Kanna.app/Contents/MacOS/kanna-cli-aarch64-apple-darwin",
    });

    expect(command).toContain(
      "export KANNA_CLI_PATH='/Applications/Kanna.app/Contents/MacOS/kanna-cli-aarch64-apple-darwin'",
    );
    expect(command).toContain(
      "export PATH='/Applications/Kanna.app/Contents/MacOS':\"$PATH\"",
    );
    expect(command).toContain("claude 'merge it'");
  });

  it("keeps startup commands intact when no bundled kanna-cli path is available", () => {
    const command = buildTaskShellCommand("codex 'ship it'", ["bun test"]);

    expect(command).toContain("Running startup...");
    expect(command).toContain("printf '\\033[2m$ %s\\033[0m\\n' 'bun test' && ( bun test )");
    expect(command).toContain("codex 'ship it'");
  });

  it("prints the agent command before launching it", () => {
    const command = buildTaskShellCommand("codex 'ship it'", ["bun test"]);

    expect(command).toContain("printf '\\033[2m$ %s\\033[0m\\n' 'codex '\\''ship it'\\'''");
    expect(command).toContain("&& codex 'ship it'");
  });

  it("can print the agent command while launching it with a preamble", () => {
    const command = buildTaskShellCommand("codex 'ship it'", [], {
      agentCmdPreamble: "codex 'Kanna context\n\nship it'",
    });

    expect(command).toContain("printf '\\033[2m$ %s\\033[0m\\n' 'codex '\\''ship it'\\'''");
    expect(command).toContain("&& codex 'Kanna context\n\nship it'");
  });

  it("continues to the agent when a setup command fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "kanna-setup-failure-"));
    const marker = join(dir, "agent-started");
    const command = buildTaskShellCommand(`printf agent-started > '${marker}'`, ["false"]);

    const result = spawnSync("/bin/zsh", ["-c", command], { encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("agent-started");
    expect(result.stdout).toContain("Setup command failed");
  });

  it("truncates the visible agent command when it is too long", () => {
    const longPrompt = "x".repeat(160);
    const command = buildTaskShellCommand(`codex '${longPrompt}'`, []);
    const truncatedVisiblePrompt = "x".repeat(105);

    expect(command).toContain(`${truncatedVisiblePrompt}...`);
    expect(command).toContain(`codex '${longPrompt}'`);
  });
});

describe("getReconnectRedrawPolicy", () => {
  it("waits for Claude idle, then delays briefly, with a fallback timeout", () => {
    expect(getReconnectRedrawPolicy({ agentProvider: "claude" })).toEqual({
      waitForIdleStatus: "idle",
      settleDelayMs: 200,
      fallbackDelayMs: 2000,
    });
  });

  it("uses immediate redraw policy for other providers", () => {
    expect(getReconnectRedrawPolicy({ agentProvider: "codex" })).toEqual({
      waitForIdleStatus: null,
      settleDelayMs: 0,
      fallbackDelayMs: 0,
    });
  });
});
