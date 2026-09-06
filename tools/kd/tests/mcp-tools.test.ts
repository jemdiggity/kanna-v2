import { describe, expect, it } from "vitest";
import { buildMcpToolDefinitions } from "../src/mcp/tool-registry";

describe("MCP tool registry", () => {
  it("exposes high-value kd tools", () => {
    expect(buildMcpToolDefinitions().map((tool) => tool.name)).toEqual([
      "dev_up",
      "dev_down",
      "dev_status",
      "dev_log",
      "dev_seed",
      "clean",
      "setup",
      "build_desktop",
      "build_sidecars",
      "release_ship",
      "release_promote",
      "release_cut",
      "release_reset_staging",
      "release_status",
      "cloud_deploy",
      "cloud_relay_provision",
      "pages_build_schema",
      "test_all",
      "test_app_update_bundle",
      "test_remote_e2e",
      "test_staging_smoke",
      "emulators_up",
      "emulators_down",
      "emulators_status",
      "daemon_kill",
      "mobile_run",
      "mobile_doctor",
      "mobile_device_smoke",
      "doctor_remote",
      "doctor"
    ]);
  });

  it("requires an explicit destination, reason, and confirmation to reset the staging lineage", () => {
    const tool = buildMcpToolDefinitions().find((definition) => definition.name === "release_reset_staging");
    expect(tool?.description).toMatch(/never runs implicitly/);
    expect(() => tool?.schema.parse({ to: "main", reason: "abandoned soak" })).toThrow();
    expect(() => tool?.schema.parse({ to: "main", confirmAbandon: "1.3.0-staging.2" })).toThrow();
    expect(tool?.schema.parse({ to: "main", reason: "abandoned soak", confirmAbandon: "1.3.0-staging.2" })).toEqual({
      to: "main",
      reason: "abandoned soak",
      confirmAbandon: "1.3.0-staging.2",
      dryRun: false
    });
  });

  it("keeps the soak override an explicit opt-in on promotion", () => {
    const tool = buildMcpToolDefinitions().find((definition) => definition.name === "release_promote");
    const parsed = tool?.schema.parse({ version: "1.2.4-staging.3" }) as { overrideSoak?: string };
    expect(parsed.overrideSoak).toBeUndefined();
  });

  it("requires the recut confirmations and reason in the MCP schema", () => {
    const tool = buildMcpToolDefinitions().find((definition) => definition.name === "release_cut");
    expect(() => tool?.schema.parse({ version: "0.3.0", recut: true, reason: "move" })).toThrow();
    expect(tool?.schema.parse({
      version: "0.3.0",
      recut: true,
      reason: "move",
      confirmRecut: "0.3.0-staging.10",
      confirmOldTip: "2222222222222222222222222222222222222222"
    })).toMatchObject({ recut: true });
  });
});
