export function buildRealE2eAgentEnv(
  testTargets: string[],
  env: Record<string, string | undefined>,
): Record<string, string> {
  const hasRealSuite = testTargets.some((target) => target.includes("/real/"));
  if (!hasRealSuite) {
    return {};
  }

  return {
    KANNA_E2E_REAL_AGENT_PROVIDER: env.KANNA_E2E_REAL_AGENT_PROVIDER || "opencode",
    KANNA_E2E_REAL_AGENT_MODEL: env.KANNA_E2E_REAL_AGENT_MODEL || "opencode/big-pickle",
  };
}
