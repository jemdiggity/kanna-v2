import { describe, expect, it } from "vitest";
import { buildAppActivationEnv, buildRealE2eAgentEnv } from "./runEnv";

describe("buildRealE2eAgentEnv", () => {
  it("returns opencode and the free pickle model for real suites by default", () => {
    expect(
      buildRealE2eAgentEnv(
        ["tests/e2e/real/pty-session.test.ts"],
        {},
      ),
    ).toEqual({
      KANNA_E2E_REAL_AGENT_PROVIDER: "opencode",
      KANNA_E2E_REAL_AGENT_MODEL: "opencode/big-pickle",
    });
  });

  it("returns no override for mock suites", () => {
    expect(
      buildRealE2eAgentEnv(
        ["tests/e2e/mock/app-launch.test.ts"],
        {},
      ),
    ).toEqual({});
  });

  it("allows explicit process env to replace the default real-suite values", () => {
    expect(
      buildRealE2eAgentEnv(
        ["tests/e2e/real/pty-session.test.ts"],
        {
          KANNA_E2E_REAL_AGENT_PROVIDER: "copilot",
          KANNA_E2E_REAL_AGENT_MODEL: "gpt-5.4-nano",
        },
      ),
    ).toEqual({
      KANNA_E2E_REAL_AGENT_PROVIDER: "copilot",
      KANNA_E2E_REAL_AGENT_MODEL: "gpt-5.4-nano",
    });
  });

  it("defaults OpenCode real suites to the free pickle model", () => {
    expect(
      buildRealE2eAgentEnv(
        ["tests/e2e/real/free-model-agent-writes-file.test.ts"],
        {},
      ),
    ).toEqual({
      KANNA_E2E_REAL_AGENT_PROVIDER: "opencode",
      KANNA_E2E_REAL_AGENT_MODEL: "opencode/big-pickle",
    });
  });
});

describe("buildAppActivationEnv", () => {
  it("keeps launched app instances out of the foreground by default", () => {
    expect(buildAppActivationEnv({})).toEqual({ KANNA_E2E_NO_ACTIVATE: "1" });
  });

  it("lets an operator opt back into a foreground run", () => {
    expect(buildAppActivationEnv({ KANNA_E2E_NO_ACTIVATE: "0" })).toEqual({
      KANNA_E2E_NO_ACTIVATE: "0",
    });
  });
});
