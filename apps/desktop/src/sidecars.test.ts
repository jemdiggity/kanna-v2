import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import rootPkg from "../../../package.json";
import desktopPkg from "../package.json";
import tauriConf from "../src-tauri/tauri.conf.json";

describe("desktop sidecar packaging", () => {
  it("keeps release builds free of dev-only version and sidecar staging hooks", () => {
    expect(tauriConf.build.beforeBuildCommand).not.toContain("sync-version.sh");
    expect(tauriConf.build.beforeBuildCommand).not.toContain("build:sidecars");
    expect(desktopPkg.scripts?.dev).not.toContain("sync-version.sh");
    expect(rootPkg.scripts?.dev).not.toContain("sync-version.sh");
  });

  it("stages and builds all desktop sidecars, including kanna-server", () => {
    const buildSidecarsScript = desktopPkg.scripts?.["build:sidecars"];
    const rootBuildSidecarsScript = rootPkg.scripts?.["build:desktop-sidecars"];
    const stageSidecarsScript = tauriConf.bundle.externalBin.join("\n");
    expect(buildSidecarsScript).toBe("pnpm -C ../.. run build:desktop-sidecars");
    expect(rootBuildSidecarsScript).toBe("./kd build sidecars");
    expect(tauriConf.bundle.externalBin).toContain("binaries/kanna-terminal-recovery");
    expect(stageSidecarsScript).toContain("binaries/kanna-terminal-recovery");
    expect(stageSidecarsScript).toContain("binaries/kanna-daemon");
    expect(stageSidecarsScript).toContain("binaries/kanna-cli");
    expect(tauriConf.bundle.externalBin).toContain("binaries/kanna-mcp");
    expect(stageSidecarsScript).toContain("binaries/kanna-mcp");
    expect(stageSidecarsScript).toContain("binaries/kanna-server");
  });

  it("stages and bundles the task transfer sidecar", () => {
    const buildSidecarsScript = desktopPkg.scripts?.["build:sidecars"];
    const rootBuildSidecarsScript = rootPkg.scripts?.["build:desktop-sidecars"];
    const stageSidecarsScript = tauriConf.bundle.externalBin.join("\n");
    expect(buildSidecarsScript).toBe("pnpm -C ../.. run build:desktop-sidecars");
    expect(rootBuildSidecarsScript).toBe("./kd build sidecars");
    expect(tauriConf.bundle.externalBin).toContain("binaries/kanna-task-transfer");
    expect(stageSidecarsScript).toContain("binaries/kanna-task-transfer");
  });

  it("keeps Bazel release bundles in sync with the desktop sidecar set", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const bazelBuild = readFileSync(resolve(repoRoot, "BUILD.bazel"), "utf8");
    const moduleBazel = readFileSync(resolve(repoRoot, "MODULE.bazel"), "utf8");

    expect(bazelBuild).toContain('name = "kanna_bundle_inputs_release_arm64"');
    expect(bazelBuild).toContain('name = "kanna_bundle_inputs_release_x86_64"');
    expect(bazelBuild).toContain('":kanna_cli_release_arm64"');
    expect(bazelBuild).toContain('":kanna_mcp_release_arm64"');
    expect(bazelBuild).toContain('":kanna_daemon_release_arm64"');
    expect(bazelBuild).toContain('":kanna_terminal_recovery_release_arm64"');
    expect(bazelBuild).toContain('":kanna_server_release_arm64"');
    expect(bazelBuild).toContain('":kanna_task_transfer_release_arm64"');
    expect(bazelBuild).toContain('":kanna_cli_release_x86_64"');
    expect(bazelBuild).toContain('":kanna_mcp_release_x86_64"');
    expect(bazelBuild).toContain('":kanna_daemon_release_x86_64"');
    expect(bazelBuild).toContain('":kanna_terminal_recovery_release_x86_64"');
    expect(bazelBuild).toContain('":kanna_server_release_x86_64"');
    expect(bazelBuild).toContain('":kanna_task_transfer_release_x86_64"');
    expect(moduleBazel).toContain('name = "kanna_mcp_crates"');
    expect(moduleBazel).toContain('manifests = ["//crates/kanna-mcp:Cargo.toml"]');
    expect(moduleBazel).toContain('name = "kanna_server_crates"');
    expect(moduleBazel).toContain('manifests = ["//:Cargo.server.toml"]');
    expect(moduleBazel).toContain('name = "task_transfer_crates"');
    expect(moduleBazel).toContain('manifests = ["//:Cargo.task-transfer.toml"]');
  });

  it("builds sidecars as a prerequisite and keeps beforeDevCommand limited to vite", () => {
    expect(desktopPkg.scripts?.dev).not.toContain("build:sidecars");
    expect(desktopPkg.scripts?.dev).toContain("vite");
    expect(tauriConf.build.beforeDevCommand).toBe("pnpm run dev");
    expect(tauriConf.build.beforeBuildCommand).toBe("pnpm run build");
    expect(rootPkg.scripts?.dev).toBe("./kd dev up");
  });

  it("exposes kd launcher metadata for task setup and local tool entrypoints", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const kdPackagePath = resolve(repoRoot, "tools/kd/package.json");
    const kdPackage = JSON.parse(readFileSync(kdPackagePath, "utf8")) as {
      bin?: Record<string, string>;
    };
    const rootLauncher = resolve(repoRoot, "kd");
    const kdBootstrapper = resolve(repoRoot, "tools/kd/bin/kd");
    const mcpBootstrapper = resolve(repoRoot, "tools/kd/bin/kd-mcp");

    expect(kdPackage.bin?.kd).toBe("./bin/kd");
    expect(kdPackage.bin?.["kd-mcp"]).toBe("./bin/kd-mcp");
    expect(existsSync(kdBootstrapper)).toBe(true);
    expect(existsSync(mcpBootstrapper)).toBe(true);
    expect(lstatSync(rootLauncher).isSymbolicLink()).toBe(true);
    expect(readlinkSync(rootLauncher)).toBe("tools/kd/bin/kd");
  });
});
