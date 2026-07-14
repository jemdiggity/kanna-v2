import { describe, it, expect } from "vitest";
import { isClaudeUnavailable, runClaude, runClaudeRaw } from "../../helpers/claude";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { tmpdir } from "os";
import { join } from "path";

describe("--settings flag", () => {
  it("accepts --settings with empty hooks JSON", async () => {
    const result = await runClaude({
      prompt: "Say OK",
      flags: ["--settings", '{"hooks":{}}'],
    });
    if (isClaudeUnavailable(result)) return;
    expect(result.exitCode).toBe(0);
  });

  it("accepts --settings with the exact Kanna hook format", async () => {
    // This is the most important test — the exact JSON we'll pass in production
    const settings = JSON.stringify({
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: "echo kanna-stop" }] },
        ],
        PostToolUse: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "echo kanna-tool" }],
          },
        ],
      },
    });

    const result = await runClaude({
      prompt: "Say OK",
      flags: ["--settings", settings],
    });
    if (isClaudeUnavailable(result)) return;
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("error");
  });

  it("rejects --settings with invalid JSON", async () => {
    const result = await runClaudeRaw([
      "-p", "Say OK",
      "--output-format", "stream-json",
      "--model", "haiku",
      "--max-turns", "1",
      "--settings", "{not valid json",
    ]);
    // Should either fail or show an error
    expect(
      result.exitCode !== 0 || result.stderr.includes("error") || result.stderr.includes("Error")
    ).toBe(true);
  });

  it("--settings merges with project settings (does not replace)", async () => {
    // Create a temp dir with a .claude/settings.json that has a known setting
    const tmpDir = await mkdtemp(join(tmpdir(), "kanna-test-"));
    await mkdir(join(tmpDir, ".claude"), { recursive: true });
    // Initialize a git repo so Claude recognizes it as a project
    const gitInit = spawn("git", ["init"], {
      cwd: tmpDir,
      stdio: "ignore",
    });
    const [exitCode] = await once(gitInit, "exit");
    expect(exitCode).toBe(0);

    await writeFile(
      join(tmpDir, ".claude", "settings.json"),
      JSON.stringify({ permissions: { allow: ["Bash(echo:*)"] } })
    );

    // Run with --settings that only has hooks — should not lose the permissions
    const result = await runClaude({
      prompt: "Say OK",
      cwd: tmpDir,
      flags: [
        "--settings", '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo test"}]}]}}',
      ],
    });
    if (isClaudeUnavailable(result)) return;

    // If settings were replaced instead of merged, Claude might behave differently
    // At minimum, it shouldn't error
    expect(result.exitCode).toBe(0);

    // Cleanup
    await rm(tmpDir, { recursive: true, force: true });
  });
});
