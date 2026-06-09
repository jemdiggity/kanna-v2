import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import desktopPkg from "../package.json";

const repoRoot = resolve(process.cwd(), "../..");

describe("full-bundle app update E2E script", () => {
  const script = readFileSync(
    resolve(repoRoot, "scripts/app-update-full-bundle-e2e.sh"),
    "utf8",
  );

  it("is exposed as an explicit opt-in desktop test script", () => {
    expect(desktopPkg.scripts["test:e2e:app-update:bundle"]).toBe(
      "pnpm -C ../.. exec kd test app-update-bundle",
    );
  });

  it("builds signed updater artifacts from temporary debug app bundles", () => {
    expect(script).toContain("mktemp -d");
    expect(script).toContain("run build:sidecars");
    expect(script).toContain("run build");
    expect(script).toContain("find_free_port");
    expect(script).toContain("tauri signer generate --ci");
    expect(script).toMatch(/tauri signer sign\s+\\\n\s+--private-key-path/);
    expect(script).toMatch(/tauri build\s+\\\n\s+--debug\s+\\\n\s+--bundles app\s+\\\n\s+--no-sign/);
    expect(script).toContain("create_updater_bundle");
    expect(script).toContain("make_app_dirs_readonly \"$NEW_APP_SOURCE\"");
    expect(script).toContain("find \"$stage_app\" -type d -exec chmod u+rwx,go+rx {} +");
    expect(script).toContain("COPYFILE_DISABLE=1 tar");
    expect(script).toContain("latest.json");
  });

  it("updates only a temporary installed app bundle", () => {
    expect(script).toContain("INSTALL_ROOT=");
    expect(script).toContain("pwd -P");
    expect(script).toContain("cp -R \"$OLD_APP_SOURCE\" \"$INSTALLED_APP\"");
    expect(script).toContain("CFBundleShortVersionString");
    expect(script).not.toContain("/Applications/Kanna.app");
  });

  it("drives the real updater through WebDriver against localhost", () => {
    expect(script).toContain("KANNA_WEBDRIVER_PORT");
    expect(script).toContain("env -u KANNA_WORKTREE");
    expect(script).toContain("http://127.0.0.1:");
    expect(script).toContain("Update available");
    expect(script).toContain("Ready to restart");
    expect(script).toContain("update-install");
    expect(script).toContain("raw updater check");
  });

  it("verifies native window bounds and position survive the updater restart", () => {
    expect(script).toContain("EXPECTED_WINDOW_RECT");
    expect(script).toContain("setWindowRect(sessionId, expectedRect)");
    expect(script).toContain("await click(sessionId, '[data-testid=\"update-restart\"]')");
    expect(script).toContain("await waitForSessionGone(sessionId)");
    expect(script).toContain("const relaunchedSession = await request(\"POST\", \"/session\", { capabilities: {} })");
    expect(script).toContain("assertRestoredWindowRect(relaunchedSessionId, expectedRect)");
    expect(script).toContain("Window state was not restored after updater relaunch");
  });
});
