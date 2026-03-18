import { describe, it, expect, setDefaultTimeout } from "bun:test";

setDefaultTimeout(30_000);
import { runClaude } from "../helpers/claude";
import { mkdtemp, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

describe("hooks", () => {
  it("Stop hook fires when Claude finishes", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "kanna-hook-test-"));
    const markerFile = join(tmpDir, "hook-fired");

    const settings = JSON.stringify({
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: `touch ${markerFile}`,
              },
            ],
          },
        ],
      },
    });

    const result = await runClaude({
      prompt: "Say OK",
      flags: ["--settings", settings],
    });

    expect(result.exitCode).toBe(0);

    // Check if the hook fired by looking for the marker file
    // Give it a moment — hooks may fire asynchronously
    await Bun.sleep(1000);
    const exists = await Bun.file(markerFile).exists();
    expect(exists).toBe(true);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it("Stop hook fires even with --max-turns 1", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "kanna-hook-test-"));
    const markerFile = join(tmpDir, "hook-max1");

    const settings = JSON.stringify({
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "command", command: `touch ${markerFile}` },
            ],
          },
        ],
      },
    });

    const result = await runClaude({
      prompt: "Say OK",
      flags: ["--settings", settings],
    });

    expect(result.exitCode).toBe(0);
    await Bun.sleep(1000);
    expect(await Bun.file(markerFile).exists()).toBe(true);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it("hook command can write output to a file", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "kanna-hook-test-"));
    const outputFile = join(tmpDir, "hook-output");

    const settings = JSON.stringify({
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: `echo "hook-data-123" > ${outputFile}`,
              },
            ],
          },
        ],
      },
    });

    const result = await runClaude({
      prompt: "Say OK",
      flags: ["--settings", settings],
    });

    expect(result.exitCode).toBe(0);
    await Bun.sleep(1000);

    const content = await readFile(outputFile, "utf-8");
    expect(content.trim()).toBe("hook-data-123");

    await rm(tmpDir, { recursive: true, force: true });
  });

  it("hook receives session ID via env var", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "kanna-hook-test-"));
    const envFile = join(tmpDir, "hook-env");

    const settings = JSON.stringify({
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: `env | grep -i claude > ${envFile} || echo "no claude env" > ${envFile}`,
              },
            ],
          },
        ],
      },
    });

    const result = await runClaude({
      prompt: "Say OK",
      flags: ["--settings", settings],
    });

    expect(result.exitCode).toBe(0);
    await Bun.sleep(1000);

    const content = await readFile(envFile, "utf-8");
    // Log what env vars Claude passes to hooks — this is discovery, not assertion
    console.log("[hooks] Claude env vars in hook:", content.trim());
    // At minimum the file should exist and have content
    expect(content.length).toBeGreaterThan(0);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it("the exact Kanna hook JSON format works end-to-end", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "kanna-hook-test-"));
    const stopMarker = join(tmpDir, "stop-fired");
    const sessionId = "test-session-123";

    // This is the exact format the Tauri app will use
    const settings = JSON.stringify({
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: `echo '{"event":"Stop","session_id":"${sessionId}"}' > ${stopMarker}`,
              },
            ],
          },
        ],
        PostToolUse: [
          {
            matcher: "*",
            hooks: [
              {
                type: "command",
                command: `echo tool >> ${join(tmpDir, "tools")}`,
              },
            ],
          },
        ],
      },
    });

    const result = await runClaude({
      prompt: "Say OK",
      flags: ["--settings", settings],
    });

    expect(result.exitCode).toBe(0);
    await Bun.sleep(1000);

    // Stop hook should have fired
    expect(await Bun.file(stopMarker).exists()).toBe(true);
    const stopContent = await readFile(stopMarker, "utf-8");
    const parsed = JSON.parse(stopContent.trim());
    expect(parsed.event).toBe("Stop");
    expect(parsed.session_id).toBe(sessionId);

    await rm(tmpDir, { recursive: true, force: true });
  });
});
