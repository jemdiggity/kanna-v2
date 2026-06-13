import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  executeDevDownWithContext,
  executeDevStatus,
  executeProductionMobileUpWithContext
} from "../src/tasks/registry";
import type { CommandRunner } from "../src/runtime/process";

describe("task executors", () => {
  it("reports no running tmux session as ok status", async () => {
    const runner: CommandRunner = {
      async run(command, args) {
        expect(command).toBe("tmux");
        expect(args).toEqual(["-L", "kanna-task-abc", "has-session", "-t", "kanna-task-abc"]);
        return { exitCode: 1, stdout: "", stderr: "no server running" };
      }
    };

    const result = await executeDevStatus({
      runner,
      context: {
        repoRoot: "/repo/.kanna-worktrees/task-abc",
        tmux: { server: "kanna-task-abc", session: "kanna-task-abc" },
        ports: { KANNA_DEV_PORT: 1421, KANNA_MOBILE_PORT: 8082 },
        env: {}
      }
    });

    expect(result).toEqual({
      ok: true,
      message: "Kanna dev session is not running.",
      data: {
        running: false,
        session: "kanna-task-abc",
        server: "kanna-task-abc"
      }
    });
  });

  it("runs workspace daemon cleanup when dev down asks to kill daemons", async () => {
    const calls: string[] = [];
    const killed: number[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push(`${command} ${args.join(" ")}`);
        if (args.includes("has-session")) {
          return { exitCode: 1, stdout: "", stderr: "no server running" };
        }
        if (command === "ps") {
          return { exitCode: 0, stdout: " 123 /repo/.build/debug/kanna-daemon\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    const result = await executeDevDownWithContext(
      { killDaemon: true },
      {
        runner,
        context: {
          repoRoot: "/repo",
          tmux: { server: "kanna-task-abc", session: "kanna-task-abc" },
          ports: {},
          env: { KANNA_DAEMON_DIR: "/repo/.kanna-daemon" }
        }
      },
      { killProcess: (pid) => killed.push(pid) }
    );

    expect(result.data).toEqual({
      stopped: false,
      daemonCleanup: {
        orphanedKilled: [{ pid: 123, command: "/repo/.build/debug/kanna-daemon" }]
      }
    });
    expect(killed).toEqual([123]);
    expect(calls).toEqual([
      "tmux -L kanna-task-abc has-session -t kanna-task-abc",
      "ps -axo pid=,command="
    ]);
  });

  it("verifies the production desktop server before starting the mobile window", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "curl") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              desktopId: "desktop-ea554bc4",
              version: "0.0.53",
              relay_url: "wss://kanna-relay.example",
              state: "running"
            }),
            stderr: ""
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    const result = await executeProductionMobileUpWithContext(
      { production: true, staging: false },
      {
        runner,
        context: {
          repoRoot: "/repo",
          tmux: { server: "kanna-task-abc", session: "kanna-task-abc" },
          ports: { KANNA_MOBILE_PORT: 8083 },
          env: {
            KANNA_MOBILE_PORT: "8083",
            EXPO_PUBLIC_KANNA_RELAY_URL: "wss://kanna-relay.example"
          }
        }
      }
    );

    expect(result).toMatchObject({
      ok: true,
      message: "Started mobile against production desktop desktop-ea554bc4 (0.0.53).",
      data: {
        desktopId: "desktop-ea554bc4",
        version: "0.0.53",
        windows: ["mobile"]
      }
    });
    expect(calls[0]).toBe("curl --fail --silent --show-error http://127.0.0.1:48120/v1/status");
    expect(calls[1]).toContain("test -f ");
    expect(calls[1]).toContain("Library/Application Support/build.kanna/Kanna/server.toml");
    expect(calls[2]).toContain("tmux -L kanna-task-abc new-session");
    expect(calls[2]).not.toContain("EXPO_PUBLIC_KANNA_SERVER_URL");
    expect(calls.join("\n")).not.toContain("apps/desktop");
  });

  it("starts the worktree desktop and mobile against staging cloud env without requiring production desktop status", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-kd-staging-"));
    await mkdir(join(repoRoot, "apps", "desktop", "src-tauri"), { recursive: true });
    const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const runner: CommandRunner = {
      async run(command, args, options) {
        calls.push({ command, args, env: options?.env });
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    const result = await executeProductionMobileUpWithContext(
      { production: false, staging: true },
      {
        runner,
        context: {
          repoRoot,
          tmux: { server: "kanna-task-abc", session: "kanna-task-abc" },
          ports: { KANNA_DEV_PORT: 1421, KANNA_MOBILE_PORT: 8084 },
          env: {
            KANNA_DEV_PORT: "1421",
            KANNA_MOBILE_PORT: "8084",
            EXPO_PUBLIC_FIREBASE_API_KEY: "staging-api-key",
            EXPO_PUBLIC_FIREBASE_APP_ID: "staging-app-id"
          }
        }
      }
    );

    expect(result).toMatchObject({
      ok: true,
      message: "Started mobile against staging cloud environment.",
      data: {
        relayUrl: "wss://relay-staging.kanna.build",
        windows: ["desktop", "mobile"]
      }
    });
    expect(calls[0]).toMatchObject({
      command: "tmux",
      args: expect.arrayContaining(["new-session", "-n", "desktop", "-c", `${repoRoot}/apps/desktop`])
    });
    expect(calls[0]?.env?.KANNA_CLOUD_ENV).toBe("staging");
    expect(calls[0]?.env?.KANNA_FIREBASE_PROJECT_ID).toBe("kanna-staging");
    expect(calls[0]?.env?.KANNA_RELAY_URL).toBe("wss://relay-staging.kanna.build");
    expect(calls[2]).toMatchObject({
      command: "tmux",
      args: expect.arrayContaining(["new-window", "-n", "mobile", "-c", `${repoRoot}/apps/mobile`])
    });
    expect(calls[2]?.args.join(" ")).toContain("KANNA_APP_ENV='staging'");
    expect(calls[2]?.args.join(" ")).toContain("EXPO_PUBLIC_FIREBASE_PROJECT_ID='kanna-staging'");
    expect(calls[2]?.args.join(" ")).toContain("EXPO_PUBLIC_KANNA_RELAY_URL='wss://relay-staging.kanna.build'");
    expect(calls.map((call) => `${call.command} ${call.args.join(" ")}`).join("\n")).not.toContain("curl --fail");
  });
});
