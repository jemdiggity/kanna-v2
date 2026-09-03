import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import desktopPkg from "../package.json";
import tauriConf from "../src-tauri/tauri.conf.json";

const repoRoot = resolve(process.cwd(), "../..");
const UPDATE_ENDPOINT =
  "https://github.com/tampopogk/kanna/releases/latest/download/latest.json";

describe("desktop updater runtime", () => {
  it("adds the official updater and process JavaScript plugins", () => {
    expect(desktopPkg.dependencies?.["@tauri-apps/plugin-updater"]).toBeDefined();
    expect(desktopPkg.dependencies?.["@tauri-apps/plugin-process"]).toBeDefined();
    expect(desktopPkg.dependencies?.["@tauri-apps/plugin-window-state"]).toBeUndefined();
  });

  it("enables updater artifact generation and configures the release endpoint", () => {
    expect(tauriConf.bundle.createUpdaterArtifacts).toBe(true);
    expect(tauriConf.plugins?.updater?.endpoints).toEqual([UPDATE_ENDPOINT]);
    expect(tauriConf.plugins?.updater?.pubkey).toBe("");
  });

  it("grants updater and restart permissions to the main capability", () => {
    const capability = readFileSync(
      resolve(repoRoot, "apps/desktop/src-tauri/capabilities/default.json"),
      "utf8",
    );

    expect(capability).toContain('"updater:default"');
    expect(capability).toContain('"process:allow-restart"');
    expect(capability).not.toContain('"window-state:default"');
  });

  it("injects the updater pubkey and registers the official Rust plugins", () => {
    const cargoToml = readFileSync(
      resolve(repoRoot, "apps/desktop/src-tauri/Cargo.toml"),
      "utf8",
    );
    const buildScript = readFileSync(
      resolve(repoRoot, "apps/desktop/src-tauri/build.rs"),
      "utf8",
    );
    const desktopLib = readFileSync(
      resolve(repoRoot, "apps/desktop/src-tauri/src/lib.rs"),
      "utf8",
    );
    const desktopBuild = readFileSync(
      resolve(repoRoot, "apps/desktop/src-tauri/BUILD.bazel"),
      "utf8",
    );
    const bazelRc = readFileSync(resolve(repoRoot, ".bazelrc"), "utf8");
    const bazelDefs = readFileSync(
      resolve(repoRoot, "tools/bazel/defs.bzl"),
      "utf8",
    );
    const bazelWorkspaceCargoToml = readFileSync(
      resolve(repoRoot, "Cargo.desktop.toml"),
      "utf8",
    );
    const deltaUpdaterWorkspaceCargoToml = readFileSync(
      resolve(repoRoot, "Cargo.delta-updater.toml"),
      "utf8",
    );
    const moduleBazel = readFileSync(resolve(repoRoot, "MODULE.bazel"), "utf8");

    expect(cargoToml).toContain('tauri-plugin-process = "2"');
    expect(cargoToml).toContain('tauri-plugin-updater = "2"');
    expect(cargoToml).not.toContain("tauri-plugin-window-state");
    expect(cargoToml).toContain('serde_json = "1"');
    expect(cargoToml).not.toContain("tauri-plugin-delta-updater");
    expect(buildScript).toContain("cargo:rerun-if-env-changed=KANNA_UPDATER_PUBKEY");
    expect(buildScript).toContain('std::env::var("TAURI_CONFIG")');
    expect(buildScript).toContain("std::env::set_var(");
    expect(buildScript).toContain('"TAURI_CONFIG",');
    expect(buildScript).toContain('std::env::var("KANNA_UPDATER_PUBKEY")');
    expect(buildScript).not.toContain("cargo:rustc-env=KANNA_UPDATER_PUBKEY=");
    expect(desktopLib).toContain("tauri_plugin_process::init()");
    expect(desktopLib).toContain("tauri_plugin_updater::Builder::new()");
    expect(desktopLib).not.toContain("tauri_plugin_window_state");
    expect(desktopLib).not.toContain('env!("KANNA_UPDATER_PUBKEY")');
    expect(desktopLib).not.toContain(".pubkey(");
    expect(desktopLib).not.toContain(".updater_builder()");
    expect(desktopLib).not.toContain(".endpoints(vec![KANNA_UPDATE_ENDPOINT.parse()?])?");
    expect(desktopLib).not.toContain("tauri_plugin_delta_updater::init()");
    expect(desktopBuild).toContain('name = "tauri_updater_bazel_config"');
    expect(desktopBuild).toContain("KANNA_UPDATER_PUBKEY");
    expect(desktopBuild).toContain('config = ":tauri_updater_bazel_config"');
    expect(desktopBuild).not.toContain('"KANNA_UPDATER_PUBKEY": ""');
    expect(desktopBuild).not.toContain("//crates/tauri-plugin-delta-updater:tauri_plugin_delta_updater");
    expect(bazelRc).toContain("build --action_env=KANNA_UPDATER_PUBKEY");
    expect(bazelDefs).toContain(
      'config = _single_output(ctx.attr.config, "config") if ctx.attr.config else _find_named_file(ctx.files.cargo_srcs, "tauri.conf.json", "cargo_srcs")',
    );
    expect(bazelDefs).toContain('"config": attr.label(allow_single_file = True)');
    expect(bazelDefs).toContain(
      "ctx.files.cargo_srcs + ctx.files.tauri_build_data + [config, frontend_dist] + dep_target_files",
    );
    expect(bazelDefs).toContain(
      "ctx.files.cargo_srcs + ctx.files.tauri_build_data + [config, embedded_assets_rust, acl_out_dir]",
    );
    expect(bazelWorkspaceCargoToml).toContain("apps/desktop/src-tauri");
    expect(bazelWorkspaceCargoToml).toContain("crates/claude-agent-sdk");
    expect(bazelWorkspaceCargoToml).not.toContain("crates/daemon");
    expect(bazelWorkspaceCargoToml).not.toContain("crates/kanna-cli");
    expect(bazelWorkspaceCargoToml).not.toContain(
      "crates/tauri-plugin-delta-updater",
    );
    expect(deltaUpdaterWorkspaceCargoToml).toContain(
      "crates/tauri-plugin-delta-updater",
    );
    expect(deltaUpdaterWorkspaceCargoToml).not.toContain(
      "apps/desktop/src-tauri",
    );
    expect(moduleBazel).toContain('name = "delta_updater_crates"');
    expect(moduleBazel).toContain('cargo_lockfile = "//:Cargo.delta-updater.lock"');
    expect(moduleBazel).toContain('manifests = ["//:Cargo.delta-updater.toml"]');
    expect(moduleBazel).toContain('cargo_lockfile = "//:Cargo.desktop.lock"');
  });
});
