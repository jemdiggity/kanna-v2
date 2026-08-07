import { describe, expect, it } from "vitest";
import { codexUnavailableReason, type CodexJsonResult } from "../../helpers/codex-availability";

// The lines below are verbatim captures from codex-cli 0.146.1 on 2026-08-08,
// not hand-written approximations: an exhausted ChatGPT account, and a run with
// CODEX_HOME pointed at a directory holding no auth.json.
describe("codexUnavailableReason", () => {
  it("treats an exhausted account as unavailable", () => {
    const result: CodexJsonResult = {
      exitCode: 1,
      lines: [
        { type: "thread.started", thread_id: "019fddde-b944-7dd0-bf40-a0eb660d0eb4" },
        { type: "turn.started" },
        {
          type: "error",
          message:
            "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 12:34 PM.",
        },
        {
          type: "turn.failed",
          error: {
            message:
              "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 12:34 PM.",
          },
        },
      ],
    };

    expect(codexUnavailableReason(result)).toBe("codex account is out of credits");
  });

  it("treats a 401 as unavailable", () => {
    const result: CodexJsonResult = {
      exitCode: 1,
      lines: [
        { type: "thread.started", thread_id: "019fdde0-5bae-7b71-b589-6deb756f0bdc" },
        { type: "turn.started" },
        {
          type: "turn.failed",
          error: {
            message:
              "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses, cf-ray: a278f8aefc64d744-NRT",
          },
        },
      ],
    };

    expect(codexUnavailableReason(result)).toBe("codex CLI is not authenticated");
  });

  it("does not excuse a turn codex itself failed", () => {
    // A rejected model is codex answering the question the pin asked. Skipping
    // here would turn a real contract break into a silent pass.
    const result: CodexJsonResult = {
      exitCode: 1,
      lines: [
        { type: "thread.started", thread_id: "019fddde-9a0f-78b3-9b03-0893b0d5dab0" },
        {
          type: "turn.failed",
          error: {
            message:
              '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.1-codex\' model is not supported when using Codex with a ChatGPT account."}}',
          },
        },
      ],
    };

    expect(codexUnavailableReason(result)).toBeNull();
  });

  it("never excuses a successful run", () => {
    expect(
      codexUnavailableReason({
        exitCode: 0,
        lines: [{ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }],
      }),
    ).toBeNull();
  });
});
