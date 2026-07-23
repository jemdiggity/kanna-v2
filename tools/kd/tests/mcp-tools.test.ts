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
      "release_status",
      "cloud_deploy",
      "cloud_relay_provision",
      "pages_build_schema",
      "test_ci",
      "test_app_update_bundle",
      "test_remote_e2e",
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
});
