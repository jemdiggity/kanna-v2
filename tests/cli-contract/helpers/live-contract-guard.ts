export function assertLiveAgentCliContractsEnabled(): void {
  if (process.env.KANNA_RUN_LIVE_AGENT_CLI_CONTRACTS !== "1") {
    throw new Error(
      "Live agent CLI compatibility tests are disabled. " +
      "Run `pnpm test:agent-cli-compat` from the repository root; " +
      "the suite requires installed and authenticated agent CLIs and may consume quota.",
    );
  }
}
