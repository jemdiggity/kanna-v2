import { describe, it, expect } from "vitest";
import { isClaudeUnavailable, runClaude } from "../helpers/claude";
import { AGENT_MODELS } from "../../../packages/core/src/agent-models";

// Confirms every Claude model id the app offers in its picker is accepted by the
// real `claude` CLI. An unknown model returns a result with api_error_status 404
// and a "... issue with the selected model ..." message; a healthy model does
// not. Keep this in sync with the source of truth in
// packages/core/src/agent-models.ts.
describe("claude model ids accepted by `claude --model`", () => {
  for (const model of AGENT_MODELS.claude) {
    it(`accepts --model ${model.id}`, async () => {
      // runClaude injects a default `--model haiku`; the appended flag wins.
      const result = await runClaude({
        prompt: "Reply with exactly: ok",
        flags: ["--model", model.id],
      });
      // No credentials in this environment (401/auth) — nothing to assert.
      if (isClaudeUnavailable(result)) return;

      const resultLine = result.lines.find((line) => line.type === "result");
      expect(resultLine, "claude must emit a result line").toBeDefined();
      const message = String(resultLine?.result ?? "");

      expect(
        resultLine?.api_error_status,
        `claude rejected model "${model.id}": ${message}`,
      ).not.toBe(404);
      expect(message).not.toContain("issue with the selected model");

      // The CLI echoes the requested model in the init system message.
      const init = result.lines.find((line) => line.type === "system" && line.subtype === "init");
      expect(init?.model).toBe(model.id);
    }, 60000);
  }
});
