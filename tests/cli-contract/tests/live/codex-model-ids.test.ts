import { describe, it, expect } from "vitest";
import { runCodexExec } from "../../helpers/codex";
import { AGENT_MODELS } from "../../../../packages/core/src/agent-models";

// Confirms every codex model id the app offers in its picker is accepted by the
// real `codex exec` CLI. Codex validates the model server-side and rejects an
// unknown one with a 400 "... model is not supported" error, so a healthy model
// is simply one that is NOT rejected. Keep this in sync with the source of
// truth in packages/core/src/agent-models.ts.
describe("codex model ids accepted by `codex exec -m`", () => {
  for (const model of AGENT_MODELS.codex) {
    it(`accepts -m ${model.id}`, async () => {
      const result = await runCodexExec({
        prompt: "Reply with exactly: ok. Do not run any commands.",
        flags: ["-m", model.id],
      });

      const rejection = result.lines.find(
        (line) =>
          (line.type === "error" || line.type === "turn.failed") &&
          JSON.stringify(line).includes("is not supported"),
      );
      expect(
        rejection,
        `codex rejected model "${model.id}": ${JSON.stringify(rejection)}`,
      ).toBeUndefined();
    }, 180000);
  }
});
