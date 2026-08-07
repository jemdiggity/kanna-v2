import { afterEach, describe, expect, it } from "vitest";
import { realE2eAgentModel, realE2eAgentProvider } from "./realAgentProvider";

const PROVIDER_KEY = "KANNA_E2E_REAL_AGENT_PROVIDER";
const MODEL_KEY = "KANNA_E2E_REAL_AGENT_MODEL";

afterEach(() => {
  delete process.env[PROVIDER_KEY];
  delete process.env[MODEL_KEY];
});

describe("real E2E agent provider", () => {
  it("reports the provider the runner forced", () => {
    process.env[PROVIDER_KEY] = "claude";
    expect(realE2eAgentProvider()).toBe("claude");
  });

  it("falls back to the runner's default rather than to 'unknown'", () => {
    // `runEnv.ts` defaults every real suite to opencode, so an unset variable
    // means opencode — not "no provider".
    expect(realE2eAgentProvider()).toBe("opencode");
  });

  it("ignores surrounding whitespace and empty values", () => {
    process.env[PROVIDER_KEY] = "  codex  ";
    expect(realE2eAgentProvider()).toBe("codex");
    process.env[MODEL_KEY] = "   ";
    expect(realE2eAgentModel()).toBeNull();
  });

  it("reports a pinned model when the runner set one", () => {
    process.env[MODEL_KEY] = "opencode/big-pickle";
    expect(realE2eAgentModel()).toBe("opencode/big-pickle");
  });
});
