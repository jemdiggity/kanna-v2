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
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import pkg from "../package.json";
import {
  KD_CACHE_ROOT_MARKER,
  validateKdInstallation
} from "../bin/kd-cache.mjs";
import { parseCliArgs, runCli } from "../src/cli";
import { nodeCommandRunner } from "../src/runtime/process";
import { getTaskDefinition } from "../src/tasks/registry";

interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
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
    const startedAt = Date.now();
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
      resolvePromise({
        status,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt
      });
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
      // A handshake that never answers is what this guards; a cold install on
      // a box running several suites is simply slow. Keep it finite, not tight.
    }, 120_000);

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
    const fixtureRepoRoots = Array.from({ length: 8 }, (_, index) =>
      join(tempRoot, `repo ${index + 1}`)
    );
    const home = join(tempRoot, "home");
    // Eight launchers race a real cold install (pnpm install plus a tsup
    // build) through one lease. What the test proves is the serialization
    // below — one "Installing kd:", the rest waiting — not how long the
    // install takes, and on a box running several worktrees' suites it can
    // take minutes. The budget is sized to catch a resolver that never
    // finishes, not a slow machine.
    const resolverTimeoutMs = 600_000;
    mkdirSync(home, { recursive: true });

    try {
      for (const fixtureRepoRoot of fixtureRepoRoots) {
        copyLauncherFixture(repoRoot, fixtureRepoRoot);
        initializeGitFixture(fixtureRepoRoot);
      }
      const cacheRoot = join(tempRoot, "cache");
      const env = {
        ...cleanLauncherEnv(home),
        KANNA_KD_CACHE_ROOT: cacheRoot,
        KANNA_KD_RESOLVER_TIMEOUT_MS: String(resolverTimeoutMs)
      };
      const launches = await Promise.all(
        fixtureRepoRoots.map((fixtureRepoRoot) =>
          spawnResult("./kd", ["env", "print"], {
            cwd: fixtureRepoRoot,
            env,
            timeoutMs: resolverTimeoutMs + 60_000
          })
        )
      );

      for (const [index, launch] of launches.entries()) {
        const fixtureRepoRoot = fixtureRepoRoots[index];
        expect(
          launch.status,
          `stdout:\n${launch.stdout}\nstderr:\n${launch.stderr}`
        ).toBe(0);
        // Redundant with the exit status above (an overrun is killed as 124),
        // kept as the explicit statement of the budget.
        expect(launch.durationMs).toBeLessThan(resolverTimeoutMs);
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
      const launcherDiagnostics = launches
        .map((launch) => launch.stderr)
        .join("");
      expect(launcherDiagnostics.match(/Installing kd:/g)).toHaveLength(1);
      expect(
        launcherDiagnostics.match(/Waiting for kd installation:/g)?.length ??
          0
      ).toBeGreaterThan(0);

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
      const cacheMetadata = readdirSync(cacheRoot).filter((name) =>
        name.startsWith(".")
      );
      const leases = cacheMetadata.filter((name) => name.includes(".lease-"));
      expect(leases.length).toBeGreaterThan(0);
      expect(leases.length).toBeLessThanOrEqual(fixtureRepoRoots.length);
      expect(cacheMetadata).toHaveLength(leases.length + 2);
      expect(cacheMetadata).toContain(KD_CACHE_ROOT_MARKER);
      expect(cacheMetadata.filter((name) => name.endsWith(".used")))
        .toHaveLength(1);
      expect(cacheMetadata.some((name) =>
        name.endsWith(".lock") ||
        name.includes(".candidate-") ||
        name === ".reclamation.guard"
      )).toBe(false);

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
  }, 720_000);

  it("bounds resolver startup and reports a clear timeout", async () => {
    const packageRoot = resolve(import.meta.dirname, "..");
    const repoRoot = resolve(packageRoot, "..", "..");
    const tempRoot = mkdtempSync(join(tmpdir(), "kd resolver timeout "));
    const fixtureRepoRoot = join(tempRoot, "repo");
    const home = join(tempRoot, "home");
    mkdirSync(home, { recursive: true });

    try {
      copyLauncherFixture(repoRoot, fixtureRepoRoot, {
        installDependencies: false
      });
      writeFileSync(
        join(fixtureRepoRoot, "tools/kd/bin/kd-resolver.mjs"),
        [
          'import { spawn } from "node:child_process";',
          'process.on("SIGTERM", () => {});',
          'spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], { stdio: "inherit" });',
          "setInterval(() => {}, 60_000);",
          ""
        ].join("\n")
      );

      const startedAt = Date.now();
      const launch = await spawnResult("./kd", ["env", "sync"], {
        cwd: fixtureRepoRoot,
        env: {
          ...cleanLauncherEnv(home),
          KANNA_KD_RESOLVER_TIMEOUT_MS: "50"
        },
        // A resolver that ignored its own 50ms budget hangs forever, so this
        // outer kill is the hang-breaker and the assertion below sits well
        // under it. Both are far above what the launch costs when it works.
        timeoutMs: 60_000
      });

      expect(Date.now() - startedAt).toBeLessThan(30_000);
      expect(launch.status, launch.stderr).toBe(124);
      expect(launch.stdout).toBe("");
      expect(launch.stderr).toContain(
        "kd resolver timed out after 50ms while resolving kd; terminated the resolver process group"
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

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
        // A real cold clone: pnpm install plus a tsup build. Generous because
        // the assertions below are about what the bootstrap produced, not how
        // fast it produced it.
        timeoutMs: 600_000
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
  }, 660_000);

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
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("--cloud emulators|staging"));
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("worktree server/daemon"));

    await expect(runCli(["mobile", "run", "--help"])).resolves.toBe(0);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("Usage: kd mobile run --device"));
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("defaults to apps/mobile/VERSION"));
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("KANNA_APP_VERSION is an explicit"));
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("--build <identity>"));
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("--owner <owner>"));
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("--cloud <target>"));

    await expect(runCli(["mobile", "uninstall", "--help"])).resolves.toBe(0);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("Usage: kd mobile uninstall --device"));

    await expect(runCli(["mobile", "qa", "--help"])).resolves.toBe(0);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("Usage: kd mobile qa --production"));

    await expect(runCli(["mobile", "archive", "--help"])).resolves.toBe(0);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("Usage: kd mobile archive --production"));
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("defaults to apps/mobile/VERSION"));

    await expect(runCli(["mobile", "ota", "publish", "--staging", "--help"])).resolves.toBe(0);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("Usage: kd mobile ota publish"));

    await expect(runCli(["mobile", "ota", "provision", "--help"])).resolves.toBe(0);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("Usage: kd mobile ota provision"));

    await expect(runCli(["emulators", "exec", "--help"])).resolves.toBe(0);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("Usage: kd emulators exec -- <command...>"));

    await expect(runCli(["doctor", "--remote", "--help"])).resolves.toBe(0);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("Usage: kd doctor"));

    await expect(runCli(["test", "--help"])).resolves.toBe(0);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("test all"));
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("test rust"));
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("test desktop-e2e"));
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("test staging-smoke"));

    await expect(runCli(["test", "all", "--help"])).resolves.toBe(0);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("Usage: kd test all"));

    await expect(runCli(["test", "rust", "--help"])).resolves.toBe(0);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("Usage: kd test rust"));

    await expect(runCli(["test", "desktop-e2e", "--help"])).resolves.toBe(0);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("Usage: kd test desktop-e2e"));

    await expect(runCli(["test", "desktop-e2e-operator", "--help"])).resolves.toBe(0);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("Usage: kd test desktop-e2e-operator"));

    await expect(runCli(["test", "staging-smoke", "--help"])).resolves.toBe(0);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("Usage: kd test staging-smoke"));

    await expect(runCli(["rust-cache", "--help"])).resolves.toBe(0);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("Usage: kd rust-cache <command>"));

    await expect(runCli(["pages", "--help"])).resolves.toBe(0);
    // Matched exactly, so this pins `build-schema` as the only `pages` command rather
    // than merely asserting it is present.
    expect(log).toHaveBeenLastCalledWith(
      ["Usage: kd pages <command>", "", "Commands:", "  pages build-schema --out-dir <dir>"].join("\n")
    );

    await expect(runCli(["pages", "build-schema", "--help"])).resolves.toBe(0);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("Usage: kd pages build-schema"));
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("config-schema-pages.yml"));

    await expect(runCli(["not-a-command", "--help"])).resolves.toBe(1);
    expect(error).toHaveBeenLastCalledWith("Unknown help topic: not-a-command");
  });

  it("returns a nonzero exit code for an unknown flag", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runCli(["mobile", "ota", "publish", "--unknown"])).resolves.toBe(1);
    expect(error).toHaveBeenLastCalledWith("Unknown flag: --unknown");

    await expect(runCli(["mobile", "ota", "publish", "--relay"])).resolves.toBe(1);
    expect(error).toHaveBeenLastCalledWith("Unknown flag for mobile.ota.publish: --relay");
  });

  it("returns a nonzero exit code when a portal deploy lacks required configuration", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(nodeCommandRunner, "run").mockImplementation(async (command, args) => {
      if (command === "git" && args[0] === "status") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command === "git" && args[0] === "rev-parse") {
        if (args.includes("--show-toplevel")) {
          return {
            exitCode: 0,
            stdout: `${resolve(import.meta.dirname, "..", "..", "..")}\n`,
            stderr: ""
          };
        }
        return {
          exitCode: 0,
          stdout: "1f2e3d4c5b6a79880123456789abcdef01234567\n",
          stderr: ""
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const portalEnvKeys = [
      "KANNA_WEB_PORTAL_FIREBASE_API_KEY",
      "KANNA_WEB_PORTAL_FIREBASE_APP_ID",
      "KANNA_WEB_PORTAL_STRIPE_PUBLISHABLE_KEY"
    ];
    const previousValues = portalEnvKeys.map((key) => process.env[key]);
    for (const key of portalEnvKeys) process.env[key] = "";

    try {
      await expect(runCli(["cloud", "deploy", "--staging", "--portal"])).resolves.toBe(1);
      expect(error).toHaveBeenLastCalledWith(
        "cloud deploy requires KANNA_WEB_PORTAL_FIREBASE_API_KEY to build the account portal."
      );
    } finally {
      portalEnvKeys.forEach((key, index) => {
        const previous = previousValues[index];
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      });
    }
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
      "mobile up only accepts --build, --owner, --cloud, --production, or --staging"
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
    expect(
      parseCliArgs(["mobile", "run", "--device", "--build", "dev", "--owner", "staging"])
    ).toEqual({
      taskId: "mobile.run",
      input: {
        device: true,
        production: false,
        staging: false,
        build: "dev",
        owner: "staging"
      }
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
    expect(() =>
      parseCliArgs([
        "mobile",
        "run",
        "--device",
        "--staging",
        "--confirm-bundle",
        "build.kanna.app.staging"
      ])
    ).toThrow("Unknown flag: --confirm-bundle");
    expect(() =>
      parseCliArgs([
        "mobile",
        "doctor",
        "--device",
        "--confirm-bundle",
        "build.kanna.app.staging"
      ])
    ).toThrow("Unknown flag: --confirm-bundle");
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

  it("parses desktop staging cloud as an explicit cloud axis", () => {
    expect(parseCliArgs(["dev", "up", "--cloud", "staging"])).toEqual({
      taskId: "dev.up",
      input: {
        mobile: false,
        emulators: false,
        seed: false,
        attach: false,
        deleteDb: false,
        killDaemon: false,
        cloud: "staging"
      }
    });
    expect(() => parseCliArgs(["dev", "up", "--owner", "staging"])).toThrow(
      "dev up owns its worktree server and daemon"
    );
  });

  it("parses only explicitly confirmed physical-device mobile uninstall commands", () => {
    expect(
      parseCliArgs([
        "mobile",
        "uninstall",
        "--device",
        "--staging",
        "--confirm-bundle",
        "build.kanna.app.staging"
      ])
    ).toEqual({
      taskId: "mobile.uninstall",
      input: {
        device: true,
        production: false,
        staging: true,
        confirmBundle: "build.kanna.app.staging",
        confirmProduction: false
      }
    });
    expect(
      parseCliArgs([
        "mobile",
        "uninstall",
        "--device",
        "--production",
        "--confirm-bundle",
        "build.kanna.app",
        "--confirm-production"
      ])
    ).toEqual({
      taskId: "mobile.uninstall",
      input: {
        device: true,
        production: true,
        staging: false,
        confirmBundle: "build.kanna.app",
        confirmProduction: true
      }
    });
    expect(() =>
      parseCliArgs([
        "mobile",
        "uninstall",
        "--device",
        "--confirm-bundle",
        "build.kanna.app.staging"
      ])
    ).toThrow("mobile uninstall requires exactly one of --staging or --production");
    expect(() =>
      parseCliArgs([
        "mobile",
        "uninstall",
        "--device",
        "--staging",
        "--production",
        "--confirm-bundle",
        "build.kanna.app.staging"
      ])
    ).toThrow("mobile uninstall requires exactly one of --staging or --production");
    expect(() =>
      parseCliArgs(["mobile", "uninstall", "--device", "--staging"])
    ).toThrow("mobile uninstall requires --confirm-bundle <bundle-id>");
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
    expect(parseCliArgs(["test", "all"])).toEqual({
      taskId: "test.all",
      input: {},
    });
    expect(getTaskDefinition("test.all").description).toBe(
      "Run all canonical local verification lanes.",
    );
    expect(parseCliArgs(["test", "rust"])).toEqual({
      taskId: "test.rust",
      input: {},
    });
    expect(getTaskDefinition("test.rust").description).toBe(
      "Run workspace Rust tests with daemon integration tests serialized.",
    );
    expect(parseCliArgs(["test", "desktop-e2e"])).toEqual({
      taskId: "test.desktop-e2e",
      input: {},
    });
    expect(parseCliArgs(["test", "desktop-e2e-operator"])).toEqual({
      taskId: "test.desktop-e2e-operator",
      input: {},
    });
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
      input: { dev: true, staging: false, mobileRelay: false, desktopPairing: false, ifChanged: false },
    });
    expect(parseCliArgs(["test", "remote-e2e", "--staging"])).toEqual({
      taskId: "test.remote-e2e",
      input: { dev: false, staging: true, mobileRelay: false, desktopPairing: false, ifChanged: false },
    });
    expect(parseCliArgs(["test", "remote-e2e", "--if-changed"])).toEqual({
      taskId: "test.remote-e2e",
      input: { dev: true, staging: false, mobileRelay: false, desktopPairing: false, ifChanged: true },
    });
    expect(() => parseCliArgs(["test", "remote-e2e", "--staging", "--if-changed"])).toThrow(
      "remote-e2e --if-changed applies to the dev lane only"
    );
    expect(parseCliArgs(["test", "staging-smoke"])).toEqual({
      taskId: "test.staging-smoke",
      input: {},
    });
    expect(getTaskDefinition("test.staging-smoke").description).toBe(
      "Run the staging health smoke: remote doctor, then the staging remote E2E lane.",
    );
  });

  it("parses rust-cache commands", () => {
    expect(parseCliArgs(["rust-cache", "install"])).toEqual({
      taskId: "rust-cache.install",
      input: {}
    });
    expect(parseCliArgs(["rust-cache", "status"])).toEqual({
      taskId: "rust-cache.status",
      input: {}
    });
    // `warm` is the pre-kache spelling that origin/main's setup list still runs;
    // it must keep resolving while older branches are open.
    expect(parseCliArgs(["rust-cache", "warm"])).toEqual({
      taskId: "rust-cache.install",
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
    expect(parseCliArgs([
      "release",
      "setup-notarization",
      "--profile",
      "custom-profile",
      "--keychain",
      "/Users/test/Library/Keychains/login.keychain-db"
    ])).toEqual({
      taskId: "release.setup-notarization",
      input: {
        profile: "custom-profile",
        keychain: "/Users/test/Library/Keychains/login.keychain-db"
      }
    });
    expect(() => parseCliArgs(["release", "promote", "--dry-run"])).toThrow(/requires a staging version/);
    expect(parseCliArgs(["release", "cut", "--minor"])).toEqual({
      taskId: "release.cut",
      input: { minor: true }
    });
    expect(parseCliArgs([
      "release",
      "cut",
      "--version",
      "0.2.0",
      "--abandon-series",
      "0.1",
      "--reason",
      "0.1 diverged from main"
    ])).toEqual({
      taskId: "release.cut",
      input: { version: "0.2.0", abandonSeries: "0.1", reason: "0.1 diverged from main" }
    });
    expect(() => parseCliArgs(["release", "cut", "--abandon-series"])).toThrow(/--abandon-series requires a value/);
    expect(parseCliArgs(["release", "ship", "--staging", "--release", "--branch", "release/1.3"])).toEqual({
      taskId: "release.ship",
      input: { staging: true, release: true, branch: "release/1.3" }
    });
    expect(parseCliArgs(["release", "promote", "1.2.4-staging.3", "--override-soak", "named human asked"])).toEqual({
      taskId: "release.promote",
      input: { version: "1.2.4-staging.3", overrideSoak: "named human asked" }
    });
    expect(parseCliArgs([
      "release",
      "reset-staging",
      "--to",
      "main",
      "--reason",
      "0.1 soak abandoned",
      "--confirm-abandon",
      "0.1.0-staging.8"
    ])).toEqual({
      taskId: "release.reset-staging",
      input: { to: "main", reason: "0.1 soak abandoned", confirmAbandon: "0.1.0-staging.8" }
    });
    expect(() => parseCliArgs(["release", "reset-staging", "--to"])).toThrow(/--to requires a value/);
    expect(() => parseCliArgs(["release", "promote", "1.2.4-staging.3", "--override-soak"])).toThrow(
      /--override-soak requires a reason value/
    );
    expect(() =>
      parseCliArgs(["release", "promote", "1.2.4-staging.3", "--override-soak", "--dry-run"])
    ).toThrow(/--override-soak requires a reason value/);
    expect(() =>
      parseCliArgs([
        "release",
        "reset-staging",
        "--to",
        "main",
        "--reason",
        "--dry-run",
        "--confirm-abandon",
        "1.2.4-staging.3"
      ])
    ).toThrow(/--reason requires a value/);
    expect(parseCliArgs(["release", "status"])).toEqual({
      taskId: "release.status",
      input: {}
    });
    expect(parseCliArgs(["cloud", "deploy", "--production"])).toEqual({
      taskId: "cloud.deploy",
      input: { staging: false, production: true, relay: false, functions: false, portal: false }
    });
    expect(parseCliArgs(["cloud", "deploy", "--production", "--relay"])).toEqual({
      taskId: "cloud.deploy",
      input: { staging: false, production: true, relay: true, functions: false, portal: false }
    });
    expect(parseCliArgs(["cloud", "deploy", "--staging", "--relay"])).toEqual({
      taskId: "cloud.deploy",
      input: { staging: true, production: false, relay: true, functions: false, portal: false }
    });
    expect(parseCliArgs(["cloud", "relay-provision", "--staging"])).toEqual({
      taskId: "cloud.relay-provision",
      input: { staging: true, production: false }
    });
  });
});
