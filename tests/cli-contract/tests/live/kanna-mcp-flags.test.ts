import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCodexRaw } from "../../helpers/codex";
import { runCopilot } from "../../helpers/copilot";
import { runOpenCodeRaw } from "../../helpers/opencode";

async function withMcpConfig<T>(fn: (path: string, cwd: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "kanna-cli-contract-mcp-"));
  const path = join(dir, "kanna-mcp.json");
  await writeFile(
    path,
    JSON.stringify({
      mcpServers: {
        "kanna-mcp": {
          command: "/bin/echo",
          args: ["serve"],
          env: {
            KANNA_SERVER_BASE_URL: "http://127.0.0.1:48120",
          },
        },
      },
    }),
  );

  try {
    return await fn(path, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("Kanna MCP provider flag contracts", () => {
  it("codex accepts MCP server registration through -c config overrides", async () => {
    const result = await runCodexRaw([
      "mcp",
      "list",
      "-c",
      'mcp_servers.kanna-mcp.command="/bin/echo"',
      "-c",
      'mcp_servers.kanna-mcp.args=["serve"]',
      "-c",
      'mcp_servers.kanna-mcp.env.KANNA_SERVER_BASE_URL="http://127.0.0.1:48120"',
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("kanna-mcp");
    expect(result.stdout).toContain("/bin/echo");
    expect(result.stdout).toContain("serve");
  });

  it("copilot loads the Kanna MCP config in prompt mode through --additional-mcp-config @file", async () => {
    await withMcpConfig(async (path, cwd) => {
      const result = await runCopilot({
        prompt: "Reply with exactly: ok",
        flags: ["--additional-mcp-config", `@${path}`, "--output-format", "json"],
        cwd,
        timeoutMs: 120_000,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("kanna-mcp");
      expect(result.stdout).toContain("session.mcp_server_status_changed");
    });
  }, 120_000);

  it("opencode accepts equivalent Kanna MCP registration through OPENCODE_CONFIG_CONTENT", async () => {
    const content = JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      mcp: {
        "kanna-mcp": {
          command: ["/bin/echo", "serve"],
          enabled: true,
          type: "local",
          env: {
            KANNA_SERVER_BASE_URL: "http://127.0.0.1:48120",
          },
        },
      },
    });
    const result = await runOpenCodeRaw(["debug", "config"], {
      env: { OPENCODE_CONFIG_CONTENT: content },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"mcp"');
    expect(result.stdout).toContain('"kanna-mcp"');
    expect(result.stdout).toContain('"/bin/echo"');
    expect(result.stdout).toContain('"serve"');
  });
});
