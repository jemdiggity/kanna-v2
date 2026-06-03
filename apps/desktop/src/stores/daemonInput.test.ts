import { describe, expect, it } from "vitest";
import {
  encodeAgentStageInput,
  encodeAgentStageInputChunks,
} from "./daemonInput";

function decode(bytes: number[]): string {
  return new TextDecoder().decode(new Uint8Array(bytes));
}

describe("daemonInput", () => {
  it("submits Claude stage prompts with carriage return to avoid CSI-u leaks", () => {
    expect(
      decode(encodeAgentStageInput("Stage prompt", {
        agentProvider: "claude",
        kittyKeyboard: true,
      })),
    ).toBe("\x1b[200~Stage prompt\x1b[201~\r");
  });

  it("keeps Codex stage prompt and submit as separate chunks", () => {
    const chunks = encodeAgentStageInputChunks("Stage prompt", {
      agentProvider: "codex",
      kittyKeyboard: false,
    });

    expect(chunks.map(decode)).toEqual(["Stage prompt", "\x1b[13u"]);
  });
});
