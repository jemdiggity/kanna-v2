import { execFileSync, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import pkg from "../package.json";
// @ts-expect-error The checked-in prebuild resolver is intentionally plain ESM.
import { validateKdInstallation } from "../bin/kd-cache.mjs";
import { parseCliArgs, runCli } from "../src/cli";
import { getTaskDefinition } from "../src/tasks/registry";

interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function commandPath(command: string): string {
  return execFileSync("/bin/bash", ["-lc", `command -v ${command}`], { encoding: "utf8" }).trim();
}

function spawnResult(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
  }
): Promise<SpawnResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    child.once("close", (status) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new Error(
            `${command} ${args.join(" ")} timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`
          )
        );
        return;
      }
      resolvePromise({ status, stdout, stderr });
    });
  });
}

function cleanLauncherEnv(home: string): NodeJS.ProcessEnv {
  return {
    HOME: home,
    PATH: [dirname(process.execPath), dirname(commandPath("pnpm")), "/usr/bin", "/bin"].join(":"),
    SHELL: "/bin/bash",
    CI: "1",
    npm_config_update_notifier: "false"
  };
}

function copyLauncherFixture(
  sourceRepoRoot: string,
  fixtureRepoRoot: string,
  options: { installDependencies?: boolean } = {}
): void {
  mkdirSync(join(fixtureRepoRoot, "tools"), { recursive: true });
  mkdirSync(join(fixtureRepoRoot, ".kanna"), { recursive: true });
  mkdirSync(join(fixtureRepoRoot, "apps/desktop/src-tauri"), {
    recursive: true
  });
  cpSync(resolve(sourceRepoRoot, "package.json"), resolve(fixtureRepoRoot, "package.json"));
  cpSync(resolve(sourceRepoRoot, "pnpm-workspace.yaml"), resolve(fixtureRepoRoot, "pnpm-workspace.yaml"));
  cpSync(
    resolve(sourceRepoRoot, ".kanna/config.json"),
    resolve(fixtureRepoRoot, ".kanna/config.json")
  );
  cpSync(
    resolve(sourceRepoRoot, "apps/desktop/src-tauri/tauri.conf.json"),
    resolve(fixtureRepoRoot, "apps/desktop/src-tauri/tauri.conf.json")
  );
  if (existsSync(resolve(sourceRepoRoot, "pnpm-lock.yaml"))) {
    cpSync(resolve(sourceRepoRoot, "pnpm-lock.yaml"), resolve(fixtureRepoRoot, "pnpm-lock.yaml"));
  }
  if (existsSync(resolve(sourceRepoRoot, "patches"))) {
    cpSync(resolve(sourceRepoRoot, "patches"), resolve(fixtureRepoRoot, "patches"), {
      recursive: true
    });
  }
  cpSync(resolve(sourceRepoRoot, "tools/kd"), resolve(fixtureRepoRoot, "tools/kd"), {
    recursive: true,
    filter: (source) => !source.includes("/node_modules") && !source.includes("/dist")
  });
  if (options.installDependencies !== false) {
    const sourceKdModules = resolve(sourceRepoRoot, "tools/kd/node_modules");
    const fixtureKdModules = resolve(fixtureRepoRoot, "tools/kd/node_modules");
    mkdirSync(join(fixtureKdModules, "@modelcontextprotocol"), {
      recursive: true
    });
    mkdirSync(join(fixtureKdModules, ".bin"), { recursive: true });
    for (const dependency of ["smol-toml", "yaml", "zod", "tsup"]) {
      symlinkSync(
        realpathSync(join(sourceKdModules, dependency)),
        join(fixtureKdModules, dependency),
        "dir"
      );
    }
    symlinkSync(
      realpathSync(join(sourceKdModules, "@modelcontextprotocol/sdk")),
      join(fixtureKdModules, "@modelcontextprotocol/sdk"),
      "dir"
    );
    cpSync(
      join(sourceKdModules, ".bin/tsup"),
      join(fixtureKdModules, ".bin/tsup")
    );
  }
  symlinkSync("tools/kd/bin/kd", resolve(fixtureRepoRoot, "kd"));
}

function initializeGitFixture(repoRoot: string): void {
  execFileSync("git", ["init", "-q"], { cwd: repoRoot });
  execFileSync("git", ["add", "."], { cwd: repoRoot });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Kanna Test",
      "-c",
      "user.email=kanna-test@example.invalid",
      "commit",
      "-qm",
      "fixture"
    ],
    { cwd: repoRoot }
  );
}

function runMcpExchange(
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<{
  initialize: Record<string, unknown>;
  toolsList: Record<string, unknown>;
  stderr: string;
}> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("tools/kd/bin/kd-mcp", [], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdoutBuffer = "";
    let stderr = "";
    let initialize: Record<string, unknown> | undefined;
    let toolsList: Record<string, unknown> | undefined;
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(
        new Error(
          `kd-mcp exchange timed out\nstdout:\n${stdoutBuffer}\nstderr:\n${stderr}`
        )
      );
    }, 30_000);

    child.once("error", fail);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      while (stdoutBuffer.includes("\n")) {
        const newline = stdoutBuffer.indexOf("\n");
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line) continue;

        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          fail(new Error(`kd-mcp emitted non-JSON stdout: ${line}`));
          return;
        }

        if (message.id === 1) {
          initialize = message;
          child.stdin.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              method: "notifications/initialized",
              params: {}
            })}\n`
          );
          child.stdin.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              method: "tools/list",
              params: {}
            })}\n`
          );
        } else if (message.id === 2) {
          toolsList = message;
          child.stdin.end();
          child.kill("SIGTERM");
        }
      }
    });
    child.once("close", () => {
      if (settled) return;
      clearTimeout(timer);
      if (!initialize || !toolsList) {
        fail(
          new Error(
            `kd-mcp exited before completing the exchange\nstdout:\n${stdoutBuffer}\nstderr:\n${stderr}`
          )
        );
        return;
      }
      settled = true;
      resolvePromise({ initialize, toolsList, stderr });
    });

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "kd-launcher-test", version: "1.0.0" }
        }
      })}\n`
    );
  });
}

describe("kd CLI", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exposes install-time bin entrypoints for setup scripts", () => {
    const packageRoot = resolve(import.meta.dirname, "..");
    const repoRoot = resolve(packageRoot, "..", "..");
    const rootWrapper = resolve(repoRoot, "kd");

    expect(pkg.name).toBe("@kanna/kd");
    expect(pkg.bin.kd).not.toMatch(/^\.\/dist\//);
    expect(pkg.bin.kd).toBe("./bin/kd");
    expect(existsSync(resolve(packageRoot, pkg.bin.kd))).toBe(true);
    expect(pkg.bin["kd-mcp"]).not.toMatch(/^\.\/dist\//);
    expect(pkg.bin["kd-mcp"]).toBe("./bin/kd-mcp");
    expect(existsSync(resolve(packageRoot, pkg.bin["kd-mcp"]))).toBe(true);
    expect(lstatSync(rootWrapper).isSymbolicLink()).toBe(true);
    expect(readlinkSync(rootWrapper)).toBe("tools/kd/bin/kd");
  });

  it("serializes concurrent cold launchers and serves MCP from the shared install", async () => {
    const packageRoot = resolve(import.meta.dirname, "..");
    const repoRoot = resolve(packageRoot, "..", "..");
    const tempRoot = mkdtempSync(join(tmpdir(), "kd launcher contract "));
    const fixtureRepoRoots = [
      join(tempRoot, "repo one"),
      join(tempRoot, "repo two")
    ];
    const home = join(tempRoot, "home");
    mkdirSync(home, { recursive: true });

    try {
      for (const fixtureRepoRoot of fixtureRepoRoots) {
        copyLauncherFixture(repoRoot, fixtureRepoRoot);
        initializeGitFixture(fixtureRepoRoot);
      }
      const cacheRoot = join(tempRoot, "cache");
      const env = {
        ...cleanLauncherEnv(home),
        KANNA_KD_CACHE_ROOT: cacheRoot
      };
      const launches = await Promise.all(
        fixtureRepoRoots.map((fixtureRepoRoot) =>
          spawnResult("./kd", ["env", "print"], {
            cwd: fixtureRepoRoot,
            env,
            timeoutMs: 240_000
          })
        )
      );

      for (const [index, launch] of launches.entries()) {
        const fixtureRepoRoot = fixtureRepoRoots[index];
        expect(
          launch.status,
          `stdout:\n${launch.stdout}\nstderr:\n${launch.stderr}`
        ).toBe(0);
        expect(
          (JSON.parse(launch.stdout) as { repoRoot: string }).repoRoot
        ).toBe(realpathSync(fixtureRepoRoot));
        expect(
          existsSync(resolve(fixtureRepoRoot, "tools/kd/node_modules"))
        ).toBe(true);
        expect(existsSync(resolve(fixtureRepoRoot, "tools/kd/dist"))).toBe(
          false
        );
      }
      expect(
        launches
          .map((launch) => launch.stderr)
          .join("")
          .match(/Installing kd:/g)
      ).toHaveLength(1);

      const installs = readdirSync(cacheRoot).filter((name) => !name.startsWith("."));
      expect(installs).toHaveLength(1);
      const runtime = {
        nodeMajor: process.versions.node.split(".")[0],
        platform: process.platform,
        arch: process.arch
      };
      expect(
        validateKdInstallation(
          join(cacheRoot, installs[0]),
          installs[0],
          runtime
        )
      ).toBe(true);
      expect(
        readdirSync(cacheRoot).filter((name) => name.startsWith("."))
      ).toEqual([]);

      const mcp = await runMcpExchange(fixtureRepoRoots[1], env);
      expect(mcp.stderr).toBe("");
      expect(
        (
          mcp.initialize.result as {
            serverInfo: { name: string };
          }
        ).serverInfo.name
      ).toBe("kd");
      expect(
        (
          mcp.toolsList.result as {
            tools: Array<{ name: string }>;
          }
        ).tools.map((tool) => tool.name)
      ).toContain("dev_up");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 240_000);

  it("bootstraps dependencies and installs kd from a clean clone", async () => {
    const packageRoot = resolve(import.meta.dirname, "..");
    const repoRoot = resolve(packageRoot, "..", "..");
    const tempRoot = mkdtempSync(join(tmpdir(), "kd clean clone "));
    const fixtureRepoRoot = join(tempRoot, "repo");
    const home = join(tempRoot, "home");
    mkdirSync(home, { recursive: true });

    try {
      copyLauncherFixture(repoRoot, fixtureRepoRoot, {
        installDependencies: false
      });
      initializeGitFixture(fixtureRepoRoot);
      const cacheRoot = join(tempRoot, "cache");
      const launch = await spawnResult("./kd", ["env", "print"], {
        cwd: fixtureRepoRoot,
        env: {
          ...cleanLauncherEnv(home),
          KANNA_KD_CACHE_ROOT: cacheRoot
        },
        timeoutMs: 240_000
      });

      expect(
        launch.status,
        `stdout:\n${launch.stdout}\nstderr:\n${launch.stderr}`
      ).toBe(0);
      expect(
        (JSON.parse(launch.stdout) as { repoRoot: string }).repoRoot
      ).toBe(realpathSync(fixtureRepoRoot));
      expect(launch.stderr).toContain(
        "Bootstrapping tools/kd dependencies..."
      );
      expect(launch.stderr).toContain("Installing kd:");
      expect(
        existsSync(resolve(fixtureRepoRoot, "tools/kd/node_modules"))
      ).toBe(true);
      expect(existsSync(resolve(fixtureRepoRoot, "tools/kd/dist"))).toBe(
        false
      );
      expect(
        readdirSync(cacheRoot).filter((name) => !name.startsWith("."))
      ).toHaveLength(1);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 240_000);

  it("prints contextual help for command groups and leaf commands", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runCli(["dev", "--help"])).resolves.toBe(0);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("Usage: kd dev <command>"));
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("dev up"));
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("dev restart"));

    await expect(runCli(["dev", "up", "--help"])).resolves.toBe(0);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("Usage: kd dev up"));
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("--firebase-env-from <task-or-path>"));

    await expect(runCli(["mobile", "run", "--help"])).resolves.toBe(0);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("Usage: kd mobile run --device"));

    await expect(runCli(["mobile", "qa", "--help"])).resolves.toBe(0);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("Usage: kd mobile qa --production"));

    await expect(runCli(["mobile", "archive", "--help"])).resolves.toBe(0);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("Usage: kd mobile archive --production"));

    await expect(runCli(["mobile", "ota", "publish", "--staging", "--help"])).resolves.toBe(0);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("Usage: kd mobile ota publish"));

    await expect(runCli(["mobile", "ota", "provision", "--help"])).resolves.toBe(0);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("Usage: kd mobile ota provision"));

    await expect(runCli(["emulators", "exec", "--help"])).resolves.toBe(0);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("Usage: kd emulators exec -- <command...>"));

    await expect(runCli(["doctor", "--remote", "--help"])).resolves.toBe(0);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("Usage: kd doctor"));

    await expect(runCli(["test", "--help"])).resolves.toBe(0);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("test rust"));

    await expect(runCli(["test", "rust", "--help"])).resolves.toBe(0);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("Usage: kd test rust"));

    await expect(runCli(["rust-cache", "--help"])).resolves.toBe(0);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("Usage: kd rust-cache <command>"));

    await expect(runCli(["not-a-command", "--help"])).resolves.toBe(1);
    expect(error).toHaveBeenLastCalledWith("Unknown help topic: not-a-command");
  });

  it("parses dev up with mobile and emulators flags", () => {
    expect(parseCliArgs(["dev", "up", "--mobile", "--emulators", "--seed"])).toEqual({
      taskId: "dev.up",
      input: {
        mobile: true,
        emulators: true,
        seed: true,
        attach: false,
        deleteDb: false,
        killDaemon: false
      }
    });
  });

  it("parses dev up remote as a remote-poking dev stack", () => {
    expect(parseCliArgs(["dev", "up", "--remote"])).toEqual({
      taskId: "dev.up",
      input: {
        mobile: false,
        emulators: false,
        remote: true,
        seed: false,
        attach: false,
        deleteDb: false,
        killDaemon: false
      }
    });
  });

  it("parses dev up with a borrowed Firebase emulator environment", () => {
    expect(parseCliArgs(["dev", "up", "--firebase-env-from", "task-source"])).toEqual({
      taskId: "dev.up",
      input: {
        mobile: false,
        emulators: false,
        seed: false,
        attach: false,
        deleteDb: false,
        killDaemon: false,
        firebaseEnvFrom: "task-source"
      }
    });
  });

  it("rejects starting and borrowing Firebase emulators at the same time", () => {
    expect(() =>
      parseCliArgs(["dev", "up", "--emulators", "--firebase-env-from", "task-source"])
    ).toThrow("--emulators and --firebase-env-from cannot be used together");
  });

  it("registers the dev status task", () => {
    expect(getTaskDefinition("dev.status").description).toBe("Show Kanna dev environment status.");
  });

  it("parses dev down with kill daemon", () => {
    expect(parseCliArgs(["dev", "down", "--kill-daemon"])).toEqual({
      taskId: "dev.down",
      input: { killDaemon: true }
    });
  });

  it("parses component-scoped dev restart commands", () => {
    expect(parseCliArgs(["dev", "restart", "desktop"])).toEqual({
      taskId: "dev.restart",
      input: {
        component: "desktop",
        mobile: false,
        emulators: false,
        seed: false,
        attach: false,
        deleteDb: false,
        killDaemon: false,
        staging: false,
        production: false
      }
    });
    expect(parseCliArgs(["restart", "mobile", "--staging"])).toEqual({
      taskId: "dev.restart",
      input: {
        component: "mobile",
        mobile: false,
        emulators: false,
        seed: false,
        attach: false,
        deleteDb: false,
        killDaemon: false,
        staging: true,
        production: false
      }
    });
  });

  it("parses opt-in desktop credentials for supported dev and staging launch commands", () => {
    expect(parseCliArgs(["dev", "up", "--with-credentials"])).toEqual({
      taskId: "dev.up",
      input: {
        mobile: false,
        emulators: false,
        seed: false,
        attach: false,
        deleteDb: false,
        killDaemon: false,
        withCredentials: true
      }
    });
    expect(parseCliArgs(["up", "--with-credentials"])).toEqual({
      taskId: "dev.up",
      input: {
        mobile: false,
        emulators: false,
        seed: false,
        attach: false,
        deleteDb: false,
        killDaemon: false,
        withCredentials: true
      }
    });
    expect(parseCliArgs(["dev", "up", "--staging", "--with-credentials"])).toEqual({
      taskId: "dev.up",
      input: {
        mobile: false,
        emulators: false,
        seed: false,
        attach: false,
        deleteDb: false,
        killDaemon: false,
        staging: true,
        withCredentials: true
      }
    });
    expect(parseCliArgs(["start", "--staging", "--with-credentials"])).toEqual({
      taskId: "dev.up",
      input: {
        mobile: false,
        emulators: false,
        seed: false,
        attach: false,
        deleteDb: false,
        killDaemon: false,
        staging: true,
        withCredentials: true
      }
    });
    expect(parseCliArgs(["up", "--staging", "--with-credentials"])).toEqual({
      taskId: "dev.up",
      input: {
        mobile: false,
        emulators: false,
        seed: false,
        attach: false,
        deleteDb: false,
        killDaemon: false,
        staging: true,
        withCredentials: true
      }
    });
    expect(parseCliArgs(["dev", "up", "--mobile", "--emulators", "--with-credentials"])).toEqual({
      taskId: "dev.up",
      input: {
        mobile: true,
        emulators: true,
        seed: false,
        attach: false,
        deleteDb: false,
        killDaemon: false,
        withCredentials: true
      }
    });
    expect(parseCliArgs(["mobile", "up", "--with-credentials"])).toEqual({
      taskId: "dev.up",
      input: {
        mobile: true,
        emulators: true,
        seed: false,
        attach: false,
        deleteDb: false,
        killDaemon: false,
        withCredentials: true
      }
    });
    expect(parseCliArgs(["mobile", "run", "--device", "--with-credentials"])).toEqual({
      taskId: "mobile.run",
      input: {
        device: true,
        production: false,
        staging: false,
        withCredentials: true
      }
    });
    expect(parseCliArgs(["dev", "restart", "desktop", "--with-credentials"])).toEqual({
      taskId: "dev.restart",
      input: {
        component: "desktop",
        mobile: false,
        emulators: false,
        seed: false,
        attach: false,
        deleteDb: false,
        killDaemon: false,
        staging: false,
        production: false,
        withCredentials: true
      }
    });
    expect(parseCliArgs(["dev", "restart", "desktop", "--staging", "--with-credentials"])).toEqual({
      taskId: "dev.restart",
      input: {
        component: "desktop",
        mobile: false,
        emulators: false,
        seed: false,
        attach: false,
        deleteDb: false,
        killDaemon: false,
        staging: true,
        production: false,
        withCredentials: true
      }
    });
    expect(parseCliArgs(["dev", "restart", "desktop", "--with-credentials"])).toEqual({
      taskId: "dev.restart",
      input: {
        component: "desktop",
        mobile: false,
        emulators: false,
        seed: false,
        attach: false,
        deleteDb: false,
        killDaemon: false,
        staging: false,
        production: false,
        withCredentials: true
      }
    });
    expect(() => parseCliArgs(["mobile", "up", "--production", "--with-credentials"])).toThrow(
      "--with-credentials is only supported for dev or staging desktop launch commands"
    );
    expect(() => parseCliArgs(["mobile", "up", "--staging", "--with-credentials"])).toThrow(
      "--with-credentials is only supported for dev or staging desktop launch commands"
    );
    expect(() => parseCliArgs(["mobile", "run", "--device", "--staging", "--with-credentials"])).toThrow(
      "--with-credentials is only supported for dev or staging desktop launch commands"
    );
    expect(() => parseCliArgs(["mobile", "doctor", "--device", "--staging", "--with-credentials"])).toThrow(
      "--with-credentials is only supported for dev or staging desktop launch commands"
    );
    expect(() => parseCliArgs(["dev", "restart", "mobile", "--staging", "--with-credentials"])).toThrow(
      "--with-credentials is only supported for dev or staging desktop launch commands"
    );
  });

  it("keeps no-arg dev restart as a whole-stack restart", () => {
    expect(parseCliArgs(["dev", "restart"])).toEqual({
      taskId: "dev.restart",
      input: {
        mobile: false,
        emulators: false,
        seed: false,
        attach: false,
        deleteDb: false,
        killDaemon: false,
        staging: false,
        production: false
      }
    });
  });

  it("parses dev log window argument", () => {
    expect(parseCliArgs(["dev", "log", "mobile"])).toEqual({
      taskId: "dev.log",
      input: { window: "mobile" }
    });
  });

  it("parses aliases for mobile and emulator commands", () => {
    expect(parseCliArgs(["mobile", "up"])).toEqual({
      taskId: "dev.up",
      input: {
        mobile: true,
        emulators: false,
        seed: false,
        attach: false,
        deleteDb: false,
        killDaemon: false
      }
    });
    expect(parseCliArgs(["mobile", "up", "--production"])).toEqual({
      taskId: "mobile.up",
      input: {
        production: true,
        staging: false
      }
    });
    expect(parseCliArgs(["mobile", "up", "--staging"])).toEqual({
      taskId: "mobile.up",
      input: {
        production: false,
        staging: true
      }
    });
    expect(() => parseCliArgs(["mobile", "up", "--production", "--emulators"])).toThrow(
      "mobile up only accepts --production or --staging"
    );
    expect(parseCliArgs(["emulators", "up"])).toEqual({
      taskId: "emulators.up",
      input: {}
    });
  });

  it("forwards help flags after emulators exec passthrough separator", () => {
    expect(parseCliArgs(["emulators", "exec", "--", "some-tool", "--help"])).toEqual({
      taskId: "emulators.exec",
      input: { extraArgs: ["some-tool", "--help"] }
    });
  });

  it("parses the physical-device mobile run command", () => {
    expect(parseCliArgs(["mobile", "run", "--device"])).toEqual({
      taskId: "mobile.run",
      input: { device: true, production: false, staging: false }
    });
    expect(parseCliArgs(["mobile", "run", "--device", "--staging"])).toEqual({
      taskId: "mobile.run",
      input: { device: true, production: false, staging: true }
    });
    expect(parseCliArgs(["mobile", "run", "--device", "--staging", "--install"])).toEqual({
      taskId: "mobile.run",
      input: { device: true, production: false, staging: true, install: true }
    });
    expect(() => parseCliArgs(["dev", "up", "--install"])).toThrow("Unknown flag: --install");
    expect(() => parseCliArgs(["--install"])).toThrow("Unknown flag: --install");
    expect(() => parseCliArgs(["mobile", "doctor", "--device", "--install"])).toThrow(
      "mobile doctor only accepts --device, --production, or --staging"
    );
    expect(parseCliArgs(["mobile", "run", "--device", "--production"])).toEqual({
      taskId: "mobile.run",
      input: { device: true, production: true, staging: false }
    });
    expect(() => parseCliArgs(["mobile", "run", "--staging", "--install"])).toThrow(
      "mobile run requires --device"
    );
    expect(() => parseCliArgs(["mobile", "run", "--device", "--production", "--staging"])).toThrow(
      "mobile run accepts only one of --production or --staging"
    );
    expect(parseCliArgs(["mobile", "doctor", "--device"])).toEqual({
      taskId: "mobile.doctor",
      input: { device: true, production: false, staging: false }
    });
  });

  it("parses production mobile QA gate commands", () => {
    expect(parseCliArgs(["mobile", "qa", "--production"])).toEqual({
      taskId: "mobile.qa",
      input: { production: true, ota: false }
    });
    expect(parseCliArgs(["mobile", "qa", "--production", "--ota"])).toEqual({
      taskId: "mobile.qa",
      input: { production: true, ota: true }
    });
    expect(() => parseCliArgs(["mobile", "qa"])).toThrow("mobile qa requires --production");
    expect(() => parseCliArgs(["mobile", "qa", "--production", "--device"])).toThrow(
      "mobile qa only accepts --production and --ota"
    );
  });

  it("maps retired wrapper argument shapes to kd tasks", () => {
    expect(parseCliArgs([])).toEqual({
      taskId: "dev.up",
      input: {
        mobile: false,
        emulators: false,
        seed: false,
        attach: false,
        deleteDb: false,
        killDaemon: false
      }
    });
    expect(parseCliArgs(["--mobile"])).toEqual({
      taskId: "dev.up",
      input: {
        mobile: true,
        emulators: false,
        seed: false,
        attach: false,
        deleteDb: false,
        killDaemon: false
      }
    });
    expect(parseCliArgs(["stop", "-k"])).toEqual({
      taskId: "dev.down",
      input: { killDaemon: true }
    });
    expect(parseCliArgs(["start", "-a", "-s", "-m"])).toEqual({
      taskId: "dev.up",
      input: {
        mobile: true,
        emulators: false,
        seed: true,
        attach: true,
        deleteDb: false,
        killDaemon: false
      }
    });
    expect(parseCliArgs(["kill-daemon"])).toEqual({
      taskId: "daemon.kill",
      input: {}
    });
    expect(parseCliArgs(["log", "mobile"])).toEqual({
      taskId: "dev.log",
      input: { window: "mobile" }
    });
  });

  it("parses explicit daemon and transfer roots", () => {
    expect(
      parseCliArgs([
        "dev",
        "up",
        "--daemon-dir",
        "/tmp/kanna-daemon",
        "--transfer-root",
        "/tmp/kanna-transfer"
      ])
    ).toEqual({
      taskId: "dev.up",
      input: {
        mobile: false,
        emulators: false,
        seed: false,
        attach: false,
        deleteDb: false,
        killDaemon: false,
        daemonDir: "/tmp/kanna-daemon",
        transferRoot: "/tmp/kanna-transfer"
      }
    });
  });

  it("parses cloud test commands", () => {
    expect(parseCliArgs(["test", "rust"])).toEqual({
      taskId: "test.rust",
      input: {},
    });
    expect(getTaskDefinition("test.rust").description).toBe(
      "Run workspace Rust tests with daemon integration tests serialized.",
    );
    expect(parseCliArgs(["test", "cloud-emulator"])).toEqual({
      taskId: "test.cloud-emulator",
      input: {},
    });
    expect(parseCliArgs(["test", "cloud-staging"])).toEqual({
      taskId: "test.cloud-staging",
      input: {},
    });
    expect(parseCliArgs(["test", "cloud-prod-smoke"])).toEqual({
      taskId: "test.cloud-prod-smoke",
      input: {},
    });
    expect(parseCliArgs(["test", "lan-lab", "--hosts", ".kanna/lab/macs.json"])).toEqual({
      taskId: "test.lan-lab",
      input: { hosts: ".kanna/lab/macs.json" },
    });
    expect(parseCliArgs(["test", "remote-e2e"])).toEqual({
      taskId: "test.remote-e2e",
      input: { dev: true, staging: false, mobileRelay: false, desktopPairing: false },
    });
    expect(parseCliArgs(["test", "remote-e2e", "--staging"])).toEqual({
      taskId: "test.remote-e2e",
      input: { dev: false, staging: true, mobileRelay: false, desktopPairing: false },
    });
  });

  it("parses rust-cache commands", () => {
    expect(parseCliArgs(["rust-cache", "warm"])).toEqual({
      taskId: "rust-cache.warm",
      input: {}
    });
    expect(parseCliArgs(["rust-cache", "status"])).toEqual({
      taskId: "rust-cache.status",
      input: {}
    });
    expect(() => parseCliArgs(["rust-cache", "record", "--layouts", "all"])).toThrow(
      "Unknown command"
    );
  });

  it("parses remote doctor commands", () => {
    expect(parseCliArgs(["doctor", "--remote"])).toEqual({
      taskId: "doctor.remote",
      input: { staging: false }
    });
    expect(parseCliArgs(["doctor", "--remote", "--staging"])).toEqual({
      taskId: "doctor.remote",
      input: { staging: true }
    });
  });

  it("parses build, clean, setup, pages, and release commands", () => {
    expect(parseCliArgs(["build", "desktop"])).toEqual({ taskId: "build.desktop", input: {} });
    expect(parseCliArgs(["clean", "--all", "--dry", "--shared-rust-build"])).toEqual({
      taskId: "clean",
      input: { all: true, dry: true, sharedRustBuild: true }
    });
    expect(parseCliArgs(["setup", "--check"])).toEqual({
      taskId: "setup",
      input: { check: true }
    });
    expect(parseCliArgs(["pages", "build-schema", "--out-dir", ".build/pages-schema"])).toEqual({
      taskId: "pages.build-schema",
      input: { outDir: ".build/pages-schema" }
    });
    expect(parseCliArgs(["release", "ship", "--dry-run", "--minor", "--arm64", "--staging"])).toEqual({
      taskId: "release.ship",
      input: { dryRun: true, minor: true, arm64: true, staging: true }
    });
    expect(parseCliArgs(["release", "ship", "--staging", "--rollback-to", "1.2.4-staging.3"])).toEqual({
      taskId: "release.ship",
      input: { staging: true, rollbackTo: "1.2.4-staging.3" }
    });
    expect(parseCliArgs(["release", "promote", "1.2.4-staging.3", "--dry-run"])).toEqual({
      taskId: "release.promote",
      input: { version: "1.2.4-staging.3", dryRun: true }
    });
    expect(() => parseCliArgs(["release", "promote", "--dry-run"])).toThrow(/requires a staging version/);
    expect(parseCliArgs(["release", "cut", "--minor"])).toEqual({
      taskId: "release.cut",
      input: { minor: true }
    });
    expect(parseCliArgs(["release", "ship", "--staging", "--release", "--branch", "release/1.3"])).toEqual({
      taskId: "release.ship",
      input: { staging: true, release: true, branch: "release/1.3" }
    });
    expect(parseCliArgs(["release", "status"])).toEqual({
      taskId: "release.status",
      input: {}
    });
    expect(parseCliArgs(["cloud", "deploy", "--production"])).toEqual({
      taskId: "cloud.deploy",
      input: { staging: false, production: true, relay: false }
    });
    expect(parseCliArgs(["cloud", "deploy", "--production", "--relay"])).toEqual({
      taskId: "cloud.deploy",
      input: { staging: false, production: true, relay: true }
    });
    expect(parseCliArgs(["cloud", "deploy", "--staging", "--relay"])).toEqual({
      taskId: "cloud.deploy",
      input: { staging: true, production: false, relay: true }
    });
    expect(parseCliArgs(["cloud", "relay-provision", "--staging"])).toEqual({
      taskId: "cloud.relay-provision",
      input: { staging: true, production: false }
    });
  });
});
