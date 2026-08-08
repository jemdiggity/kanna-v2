import { describe, expect, it } from "vitest";
import { runOpenCodeRaw } from "../../helpers/opencode";

function output(result: { stdout: string; stderr: string }): string {
  return `${result.stdout}\n${result.stderr}`;
}

/**
 * Kanna spawns OpenCode through **two different entrypoints**, and they do not
 * take the same flags:
 *
 * - PTY tasks run the CLI's *default* command, the one that draws the
 *   interactive TUI. `opencode run` — what Kanna used to spawn — streams plain
 *   text and exits at the end of its first turn, so a PTY task spawned that way
 *   had no composer for `send-input`, stage posts, revision resume or the
 *   transfer wrap-up to type into.
 * - SDK/headless tasks run `opencode run --format json`, which is legitimately
 *   one-shot: the adapter is `TurnModel::PerTurn` and respawns per turn.
 *
 * The flags below are the ones each composition site puts on the argv. A flag
 * that moves here is a spawn that dies at launch — or, worse, one that comes up
 * without the behaviour it asked for.
 */
describe("opencode CLI flags", () => {
  describe("the TUI entrypoint Kanna's PTY tasks spawn", () => {
    it("documents the prompt flag that delivers the opening turn", async () => {
      const result = await runOpenCodeRaw(["--help"]);

      expect(result.exitCode).toBe(0);
      expect(output(result)).toContain("--prompt");
    });

    it("documents the session resume flag Kanna uses", async () => {
      const result = await runOpenCodeRaw(["--help"]);

      expect(result.exitCode).toBe(0);
      expect(output(result)).toContain("--session");
    });

    it("documents the model flag Kanna uses", async () => {
      const result = await runOpenCodeRaw(["--help"]);

      expect(result.exitCode).toBe(0);
      expect(output(result)).toContain("--model");
    });

    it("documents the permission bypass flag Kanna uses", async () => {
      const result = await runOpenCodeRaw(["--help"]);

      expect(result.exitCode).toBe(0);
      expect(output(result)).toContain("--auto");
    });

    /**
     * This rejection is why reasoning effort travels in `OPENCODE_CONFIG_CONTENT`
     * rather than on the argv (`opencode_config_content` in
     * `crates/kanna-agent-protocol/src/mcp.rs`). If the TUI entrypoint ever
     * grows `--variant`, that indirection can be dropped — but until then a
     * variant on the argv means the process prints usage and exits before it
     * draws anything.
     */
    it("does NOT accept --variant, which is why effort rides in the config", async () => {
      // No `--help` here: `--help` short-circuits argument validation and exits
      // 0 whatever else is on the argv, so it cannot see this rejection. The
      // real launch is what fails — the CLI's default command takes one
      // `[project]` positional and no variant flag, so `high` is read as the
      // project path and the process prints usage and exits 1.
      const result = await runOpenCodeRaw(["--variant", "high"]);

      expect(result.exitCode).not.toBe(0);
      expect(output(result)).toContain("--prompt");
    });

    it("accepts Kanna's PTY flag combination through help parsing", async () => {
      const result = await runOpenCodeRaw([
        "--auto",
        "-m",
        "opencode/big-pickle",
        "--prompt",
        "noop",
        "--help",
      ]);

      expect(result.exitCode).toBe(0);
      expect(output(result)).not.toContain("Unknown argument");
    });
  });

  describe("the run entrypoint Kanna's SDK tasks spawn", () => {
    it("documents the JSON output format flag the adapter parses", async () => {
      const result = await runOpenCodeRaw(["run", "--help"]);

      expect(result.exitCode).toBe(0);
      expect(output(result)).toContain("--format");
    });

    it("documents the session resume flag the adapter uses", async () => {
      const result = await runOpenCodeRaw(["run", "--help"]);

      expect(result.exitCode).toBe(0);
      expect(output(result)).toContain("--session");
    });

    it("documents the model and variant flags the adapter uses", async () => {
      const result = await runOpenCodeRaw(["run", "--help"]);

      expect(result.exitCode).toBe(0);
      expect(output(result)).toContain("--model");
      expect(output(result)).toContain("--variant");
    });

    it("documents the permission bypass flag the adapter uses", async () => {
      const result = await runOpenCodeRaw(["run", "--help"]);

      expect(result.exitCode).toBe(0);
      expect(output(result)).toContain("--auto");
    });

    it("accepts the adapter's flag combination through help parsing", async () => {
      const result = await runOpenCodeRaw([
        "run",
        "--format",
        "json",
        "--auto",
        "-m",
        "opencode/big-pickle",
        "--variant",
        "high",
        "--help",
      ]);

      expect(result.exitCode).toBe(0);
      expect(output(result)).not.toContain("Unknown argument");
    });
  });
});
