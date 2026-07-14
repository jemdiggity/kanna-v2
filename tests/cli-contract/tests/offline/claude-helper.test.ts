import { describe, expect, it } from "vitest";
import { isClaudeUnavailable, type ClaudeResult } from "../../helpers/claude-availability";

describe("isClaudeUnavailable", () => {
  it("treats 401 authentication failures as unavailable", () => {
    const result: ClaudeResult = {
      stdout: "",
      stderr: "",
      exitCode: 1,
      duration: 1000,
      lines: [
        {
          type: "result",
          subtype: "success",
          is_error: true,
          api_error_status: 401,
          error: "authentication_failed",
          result:
            'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}',
        },
      ],
    };

    expect(isClaudeUnavailable(result)).toBe(true);
  });
});
