import { describe, expect, it } from "vitest";
import { checkRequiredCommands } from "../src/runtime/doctor";
import { buildMobileDeviceSmokeCommand, buildMobileTestCommand } from "../src/runtime/mobile-commands";
import { getPortStatuses } from "../src/runtime/port-status";
import { respawnTmuxWindow, startTmuxSession, stopTmuxWindow } from "../src/runtime/tmux";
import type { CommandRunner } from "../src/runtime/process";

describe("command runtime helpers", () => {
  it("checks whether Firebase emulator ports are listening", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push(`${command} ${args.join(" ")}`);
        const port = args.find((arg) => arg.startsWith("-iTCP:"))?.split(":").at(-1);
        return port === "9099"
          ? { exitCode: 0, stdout: "123\n", stderr: "" }
          : { exitCode: 1, stdout: "", stderr: "" };
      }
    };

    const statuses = await getPortStatuses(runner, {
      auth: 9099,
      firestore: 8080
    });

    expect(statuses).toEqual([
      { name: "auth", port: 9099, listening: true, pids: ["123"] },
      { name: "firestore", port: 8080, listening: false, pids: [] }
    ]);
    expect(calls).toEqual(["lsof -nP -iTCP:9099 -sTCP:LISTEN -t", "lsof -nP -iTCP:8080 -sTCP:LISTEN -t"]);
  });

  it("builds mobile test commands from the repo root", () => {
    expect(buildMobileTestCommand("/repo")).toEqual({
      command: "pnpm",
      args: ["--dir", "/repo/apps/mobile", "test"]
    });
    expect(buildMobileDeviceSmokeCommand("/repo")).toEqual({
      command: "pnpm",
      args: ["--dir", "/repo/apps/mobile", "run", "test:e2e:device:smoke"]
    });
  });

  it("reports required command availability for doctor", async () => {
    const runner: CommandRunner = {
      async run(_command, args) {
        return args.at(-1) === "tmux"
          ? { exitCode: 1, stdout: "", stderr: "" }
          : { exitCode: 0, stdout: `/usr/bin/${args.at(-1)}\n`, stderr: "" };
      }
    };

    const result = await checkRequiredCommands(runner, ["git", "pnpm", "tmux"]);

    expect(result.ok).toBe(false);
    expect(result.commands).toEqual([
      { name: "git", found: true, path: "/usr/bin/git" },
      { name: "pnpm", found: true, path: "/usr/bin/pnpm" },
      { name: "tmux", found: false }
    ]);
  });

  it("stops a single tmux window without killing the dev session", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push(`${command} ${args.join(" ")}`);
        if (args.includes("list-windows")) {
          return { exitCode: 0, stdout: "desktop\nemulators\nmobile\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    await expect(stopTmuxWindow(runner, { server: "kanna-task", session: "kanna-task" }, "emulators")).resolves.toBe(true);

    expect(calls).toEqual([
      "tmux -L kanna-task list-windows -t kanna-task -F #{window_name}",
      "tmux -L kanna-task send-keys -t kanna-task:emulators C-c",
      "tmux -L kanna-task kill-window -t kanna-task:emulators"
    ]);
  });

  it("respawns a single tmux window with the resolved window env", async () => {
    const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv; stdin?: string }> = [];
    const runner: CommandRunner = {
      async run(command, args, options) {
        calls.push({ command, args, env: options?.env, stdin: options?.stdin });
        if (args.includes("list-windows")) {
          return { exitCode: 0, stdout: "desktop\nmobile\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    await expect(
      respawnTmuxWindow(
        runner,
        { server: "kanna-task", session: "kanna-task" },
        {
          name: "desktop",
          cwd: "/repo/apps/desktop",
          command: "pnpm exec tauri dev",
          env: {
            KANNA_CLOUD_ENV: "staging",
            KANNA_DESKTOP_AUTO_SIGN_IN_EMAIL: "dev@example.com",
          }
        }
      )
    ).resolves.toBe(true);

    expect(calls).toEqual([
      {
        command: "tmux",
        args: ["-L", "kanna-task", "list-windows", "-t", "kanna-task", "-F", "#{window_name}"],
        env: undefined
      },
      {
        command: "tmux",
        args: [
          "-L",
          "kanna-task",
          "source-file",
          "-"
        ],
        env: {
          KANNA_CLOUD_ENV: "staging",
          KANNA_DESKTOP_AUTO_SIGN_IN_EMAIL: "dev@example.com",
        },
        stdin:
          "respawn-window '-k' '-t' 'kanna-task:desktop' '-c' '/repo/apps/desktop' '-e' 'KANNA_DESKTOP_AUTO_SIGN_IN_EMAIL=dev@example.com' 'pnpm exec tauri dev'\n"
      }
    ]);
    expect(calls.map((call) => call.args.join(" ")).join("\n")).not.toContain("dev@example.com");
  });

  it("adds missing windows when the tmux dev session is already running", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push(`${command} ${args.join(" ")}`);
        if (args.includes("new-session")) {
          return { exitCode: 1, stdout: "", stderr: "duplicate session: kanna-task" };
        }
        if (args.includes("list-windows")) {
          return { exitCode: 0, stdout: "desktop\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    await startTmuxSession(
      runner,
      { server: "kanna-task", session: "kanna-task" },
      [
        { name: "desktop", cwd: "/repo/apps/desktop", command: "desktop", env: {} },
        { name: "mobile", cwd: "/repo/apps/mobile", command: "mobile", env: {} },
        { name: "emulators", cwd: "/repo", command: "emulators", env: {} }
      ]
    );

    expect(calls).toEqual([
      "tmux -L kanna-task new-session -d -s kanna-task -n desktop -c /repo/apps/desktop desktop",
      "tmux -L kanna-task list-windows -t kanna-task -F #{window_name}",
      "tmux -L kanna-task new-window -t kanna-task -n mobile -c /repo/apps/mobile mobile",
      "tmux -L kanna-task new-window -t kanna-task -n emulators -c /repo emulators"
    ]);
  });
});
