import { describe, expect, it } from "vitest";
import { runOpenCodeRaw } from "../../helpers/opencode";

function output(result: { stdout: string; stderr: string }): string {
  return `${result.stdout}\n${result.stderr}`;
}

describe("opencode CLI flags", () => {
  it("run help documents the interactive TUI flag Kanna uses", async () => {
    const result = await runOpenCodeRaw(["run", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(output(result)).toContain("--interactive");
  });

  it("run help documents the session resume flag Kanna uses", async () => {
    const result = await runOpenCodeRaw(["run", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(output(result)).toContain("--session");
  });

  it("run help documents the model flag Kanna uses", async () => {
    const result = await runOpenCodeRaw(["run", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(output(result)).toContain("--model");
  });

  it("run help documents the permission bypass flag Kanna uses", async () => {
    const result = await runOpenCodeRaw(["run", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(output(result)).toContain("--dangerously-skip-permissions");
  });

  it("accepts Kanna's non-interactive flag combination through help parsing", async () => {
    const result = await runOpenCodeRaw([
      "run",
      "--interactive",
      "--dangerously-skip-permissions",
      "-m",
      "opencode/big-pickle",
      "--help",
    ]);

    expect(result.exitCode).toBe(0);
    expect(output(result)).not.toContain("Unknown argument");
  });
});
