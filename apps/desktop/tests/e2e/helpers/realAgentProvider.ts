/**
 * Which agent CLI the real-E2E runner will actually launch.
 *
 * `runEnv.ts` forces `KANNA_E2E_REAL_AGENT_PROVIDER=opencode` for every real
 * suite and that forcing is deliberate: OpenCode's free models are what make a
 * live-agent E2E affordable to run on every change, while driving Claude
 * programmatically is expensive and not something to automate. A suite that
 * needs one specific provider reads it here and skips when it is not the one
 * running, rather than failing for a reason that has nothing to do with the
 * behavior under test.
 */
export function realE2eAgentProvider(): string {
  return process.env.KANNA_E2E_REAL_AGENT_PROVIDER?.trim() || "opencode";
}

/** The model the runner pairs with that provider, if it pinned one. */
export function realE2eAgentModel(): string | null {
  const model = process.env.KANNA_E2E_REAL_AGENT_MODEL?.trim();
  return model && model.length > 0 ? model : null;
}
