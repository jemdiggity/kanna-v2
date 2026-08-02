import type { z } from "zod";
import { getTaskDefinition } from "../tasks/registry";

export interface McpToolDefinition {
  name: string;
  taskId: string;
  description: string;
  schema: z.ZodType<unknown>;
}

const exposedTools = [
  ["dev_up", "dev.up"],
  ["dev_down", "dev.down"],
  ["dev_status", "dev.status"],
  ["dev_log", "dev.log"],
  ["dev_seed", "dev.seed"],
  ["clean", "clean"],
  ["setup", "setup"],
  ["build_desktop", "build.desktop"],
  ["build_sidecars", "build.sidecars"],
  ["release_ship", "release.ship"],
  ["release_promote", "release.promote"],
  ["release_cut", "release.cut"],
  ["release_status", "release.status"],
  ["cloud_deploy", "cloud.deploy"],
  ["cloud_relay_provision", "cloud.relay-provision"],
  ["pages_build_schema", "pages.build-schema"],
  ["test_all", "test.all"],
  ["test_app_update_bundle", "test.app-update-bundle"],
  ["test_remote_e2e", "test.remote-e2e"],
  ["test_staging_smoke", "test.staging-smoke"],
  ["emulators_up", "emulators.up"],
  ["emulators_down", "emulators.down"],
  ["emulators_status", "emulators.status"],
  ["daemon_kill", "daemon.kill"],
  ["mobile_run", "mobile.run"],
  ["mobile_doctor", "mobile.doctor"],
  ["mobile_device_smoke", "mobile.device-smoke"],
  ["doctor_remote", "doctor.remote"],
  ["doctor", "doctor"]
] as const;

export function buildMcpToolDefinitions(): McpToolDefinition[] {
  return exposedTools.map(([name, taskId]) => {
    const task = getTaskDefinition(taskId);
    return {
      name,
      taskId,
      description: task.description,
      schema: task.inputSchema
    };
  });
}

export async function executeMcpTool(input: {
  name: string;
  arguments: unknown;
  cwd: string;
  env: NodeJS.ProcessEnv;
}) {
  const tool = buildMcpToolDefinitions().find((definition) => definition.name === input.name);
  if (!tool) {
    throw new Error(`Unknown kd MCP tool: ${input.name}`);
  }
  const task = getTaskDefinition(tool.taskId);
  const parsed = task.inputSchema.parse(input.arguments ?? {});
  return task.execute({ cwd: input.cwd, env: input.env }, parsed);
}
