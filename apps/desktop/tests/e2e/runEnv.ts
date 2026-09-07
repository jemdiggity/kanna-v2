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

/**
 * Keep the app instances an E2E run launches out of the foreground.
 *
 * Every instance is a real macOS app, and a real macOS app activates itself at
 * launch — taking the owner's keyboard focus mid-run, twice over for the
 * two-instance suites. The desktop reads this flag in its Tauri setup and adopts
 * a non-activating macOS activation policy; nothing else sets it, so `kd dev up`
 * and shipped builds launch normally. `kd`'s dev plan forwards every
 * `KANNA_E2E_*` var into the desktop window, so setting it on the instance env is
 * enough to reach `tauri dev`.
 *
 * Export `KANNA_E2E_NO_ACTIVATE=0` to watch a run in the foreground the old way.
 */
export function buildAppActivationEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  return { KANNA_E2E_NO_ACTIVATE: env.KANNA_E2E_NO_ACTIVATE ?? "1" };
}
