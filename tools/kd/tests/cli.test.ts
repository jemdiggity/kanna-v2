import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import pkg from "../package.json";
import { parseCliArgs } from "../src/cli";
import { getTaskDefinition } from "../src/tasks/registry";

function commandPath(command: string): string {
  return execFileSync("/bin/bash", ["-lc", `command -v ${command}`], { encoding: "utf8" }).trim();
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

function copyLauncherFixture(sourceRepoRoot: string, fixtureRepoRoot: string): void {
  mkdirSync(join(fixtureRepoRoot, "tools"), { recursive: true });
  cpSync(resolve(sourceRepoRoot, "package.json"), resolve(fixtureRepoRoot, "package.json"));
  cpSync(resolve(sourceRepoRoot, "pnpm-workspace.yaml"), resolve(fixtureRepoRoot, "pnpm-workspace.yaml"));
  if (existsSync(resolve(sourceRepoRoot, "pnpm-lock.yaml"))) {
    cpSync(resolve(sourceRepoRoot, "pnpm-lock.yaml"), resolve(fixtureRepoRoot, "pnpm-lock.yaml"));
  }
  cpSync(resolve(sourceRepoRoot, "tools/kd"), resolve(fixtureRepoRoot, "tools/kd"), {
    recursive: true,
    filter: (source) => !source.includes("/node_modules") && !source.includes("/dist")
  });
  symlinkSync("tools/kd/bin/kd", resolve(fixtureRepoRoot, "kd"));
}

describe("kd CLI", () => {
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

  it("bootstraps root kd and MCP launchers from a clean repo fixture", () => {
    const packageRoot = resolve(import.meta.dirname, "..");
    const repoRoot = resolve(packageRoot, "..", "..");
    const tempRoot = mkdtempSync(join(tmpdir(), "kd-launcher-contract-"));
    const fixtureRepoRoot = join(tempRoot, "repo");
    const home = join(tempRoot, "home");
    mkdirSync(home, { recursive: true });

    try {
      copyLauncherFixture(repoRoot, fixtureRepoRoot);
      const env = cleanLauncherEnv(home);
      const kd = spawnSync("./kd", ["--help"], {
        cwd: fixtureRepoRoot,
        env,
        encoding: "utf8",
        timeout: 180_000
      });

      expect(kd.status).toBe(0);
      expect(kd.stdout).toContain("Usage: kd <command>");
      expect(existsSync(resolve(fixtureRepoRoot, "tools/kd/node_modules"))).toBe(true);
      expect(existsSync(resolve(fixtureRepoRoot, "tools/kd/dist/bin/kd.js"))).toBe(true);

      const mcp = spawnSync("tools/kd/bin/kd-mcp", [], {
        cwd: fixtureRepoRoot,
        env,
        encoding: "utf8",
        timeout: 2_000
      });
      const mcpError = mcp.error as NodeJS.ErrnoException | undefined;

      expect(mcp.status === 0 || mcpError?.code === "ETIMEDOUT").toBe(true);
      expect(mcp.stderr).not.toContain("No such file or directory");
      expect(mcp.stderr).not.toContain("Cannot find module");
      expect(existsSync(resolve(fixtureRepoRoot, "tools/kd/dist/bin/kd-mcp.js"))).toBe(true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 240_000);

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
        production: true
      }
    });
    expect(() => parseCliArgs(["mobile", "up", "--staging"])).toThrow(
      "mobile up --staging is not supported yet"
    );
    expect(() => parseCliArgs(["mobile", "up", "--production", "--emulators"])).toThrow(
      "mobile up only accepts --production"
    );
    expect(parseCliArgs(["emulators", "up"])).toEqual({
      taskId: "emulators.up",
      input: {}
    });
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
    expect(parseCliArgs(["release", "ship", "--dry-run", "--minor", "--arm64"])).toEqual({
      taskId: "release.ship",
      input: { dryRun: true, minor: true, arm64: true }
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
    expect(parseCliArgs(["cloud", "relay-provision"])).toEqual({
      taskId: "cloud.relay-provision",
      input: {}
    });
  });
});
