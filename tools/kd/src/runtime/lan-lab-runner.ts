export interface LanLabScenarioEndpoint {
  repo: string;
  peerId: string;
  displayName: string;
  localWebDriverPort: number;
}

export interface LanLabScenarioInput {
  source: LanLabScenarioEndpoint;
  observer: LanLabScenarioEndpoint;
  prompt: string;
}

export interface BuiltLanLabScenarioCommand {
  command: "pnpm";
  args: string[];
}

export function buildLanLabScenarioCommand(input: LanLabScenarioInput): BuiltLanLabScenarioCommand {
  return {
    command: "pnpm",
    args: [
      "--dir",
      "apps/desktop",
      "exec",
      "tsx",
      "tests/e2e/helpers/lan-lab-scenario.ts",
      "--source-port",
      String(input.source.localWebDriverPort),
      "--observer-port",
      String(input.observer.localWebDriverPort),
      "--source-repo",
      input.source.repo,
      "--observer-repo",
      input.observer.repo,
      "--source-peer",
      input.source.peerId,
      "--observer-peer",
      input.observer.peerId,
      "--observer-name",
      input.observer.displayName,
      "--prompt",
      input.prompt,
    ],
  };
}
