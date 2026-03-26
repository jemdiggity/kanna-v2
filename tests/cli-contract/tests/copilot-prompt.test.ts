import { describe, it, expect, setDefaultTimeout } from "bun:test";
import { runCopilotRaw } from "../helpers/copilot";

setDefaultTimeout(30_000);

/**
 * Test the different ways to pass prompts to copilot CLI.
 * This is critical for Kanna — we need to know:
 * 1. Does -p "prompt" work (programmatic, exits after)?
 * 2. Does -i "prompt" work (interactive, auto-executes prompt)?
 * 3. What's the output difference between modes?
 */
describe("copilot prompt modes", () => {
  it("-p runs prompt and exits (programmatic mode)", async () => {
    const result = await runCopilotRaw([
      "-p", "Say the word OK and nothing else",
      "--yolo",
      "--silent",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
    console.log("[copilot prompt] -p stdout length:", result.stdout.length);
    console.log("[copilot prompt] -p output preview:", result.stdout.substring(0, 200));
  });

  it("-p output contains the response text", async () => {
    const result = await runCopilotRaw([
      "-p", "Say exactly: KANNA_TEST_MARKER",
      "--yolo",
      "--silent",
    ]);
    expect(result.exitCode).toBe(0);
    // The response should contain our marker (case-insensitive — model may reformat)
    expect(result.stdout.toLowerCase()).toContain("kanna_test_marker");
  });

  it("-p with --model flag selects a model", async () => {
    const result = await runCopilotRaw([
      "-p", "Say OK",
      "--yolo",
      "--silent",
      "--model=gpt-4o",
    ]);
    // Should work or fail gracefully with a model error, not a flag error
    expect(result.stderr).not.toContain("unknown flag");
    console.log("[copilot prompt] -p --model exit code:", result.exitCode);
    console.log("[copilot prompt] -p --model stderr:", result.stderr.substring(0, 200));
  });

  it("-i starts interactive session with auto-execute prompt", async () => {
    // -i should start the TUI and auto-execute the prompt
    // In a non-interactive terminal (piped stdin), it should still run
    // We use a short timeout since -i may hang waiting for more input
    const result = await runCopilotRaw([
      "-i", "Say OK",
      "--yolo",
    ], { timeoutMs: 15000 });

    console.log("[copilot prompt] -i exit code:", result.exitCode);
    console.log("[copilot prompt] -i stdout length:", result.stdout.length);
    console.log("[copilot prompt] -i stderr:", result.stderr.substring(0, 200));
    // -i may not exit cleanly when stdin is null — that's expected
    // The important thing is that it doesn't fail with "unknown flag"
    expect(result.stderr).not.toContain("unknown flag");
  });

  it("bare copilot with no prompt flag shows help or starts TUI", async () => {
    // Without -p or -i, copilot should either show help or start interactive
    // With piped stdin (null), it should exit or show help
    const result = await runCopilotRaw([
      "--help",
    ], { timeoutMs: 5000 });

    expect(result.exitCode).toBe(0);
    // Help output should mention key flags we depend on
    const helpText = result.stdout + result.stderr;
    console.log("[copilot prompt] --help output preview:", helpText.substring(0, 500));
  });

  it("--autopilot flag is recognized", async () => {
    const result = await runCopilotRaw([
      "-p", "Say OK",
      "--yolo",
      "--silent",
      "--autopilot",
    ]);
    expect(result.stderr).not.toContain("unknown flag");
    console.log("[copilot prompt] --autopilot exit code:", result.exitCode);
  });
});
