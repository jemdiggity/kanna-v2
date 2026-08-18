import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const cliContractTestsDir = resolve(repoRoot, "tests", "cli-contract", "tests");
const cliContractOfflineTestsDir = resolve(cliContractTestsDir, "offline");
const cliContractLiveTestsDir = resolve(cliContractTestsDir, "live");

const expectedLiveCliContractTests = [
  "agent-protocol-flags.test.ts",
  "claude-model-ids.test.ts",
  "claude-resume-rekey.test.ts",
  "claude-transcript-append.test.ts",
  "claude-transcript-location.test.ts",
  "codex-exec-json.test.ts",
  "codex-flags.test.ts",
  "codex-model-ids.test.ts",
  "codex-rollout-timing.test.ts",
  "codex-tui-quit.test.ts",
  "copilot-flags.test.ts",
  "copilot-prompt.test.ts",
  "copilot-tui-quit.test.ts",
  "flags.test.ts",
  "kanna-mcp-flags.test.ts",
  "opencode-exec-json.test.ts",
  "opencode-flags.test.ts",
  "opencode-injected-input.test.ts",
  "opencode-tui-status-markers.test.ts",
  "output.test.ts",
  "settings.test.ts",
];

const expectedOfflineCliContractTests = [
  "agent-flavor-contracts.test.ts",
  "claude-helper.test.ts",
  "claude-project-slug.test.ts",
  "codex-helper.test.ts",
  "task-effort-spawn-contract.test.ts",
  "task-model-spawn-contract.test.ts",
];

interface PackageManifest {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface TurboDryRun {
  tasks: Array<{
    taskId: string;
    inputs: Record<string, string>;
    resolvedTaskDefinition: {
      cache: boolean;
    };
  }>;
}

function testFilesUnder(directory: string, prefix = ""): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      return testFilesUnder(resolve(directory, entry.name), relativePath);
    }
    return entry.name.endsWith(".test.ts") ? [relativePath] : [];
  });
}

function manifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(resolve(repoRoot, path), "utf8")) as PackageManifest;
}

const vitestUnitPackages = [
  "apps/desktop/package.json",
  "apps/mobile/package.json",
  "packages/core/package.json",
  "packages/db/package.json",
  "packages/stream-client/package.json",
  "services/firebase-functions/package.json",
  "services/relay/package.json",
  "tests/cli-contract/package.json",
  "tests/remote-e2e/package.json",
  "tools/kd/package.json",
];

describe("test orchestration", () => {
  it("runs uncached because kd tests inspect repository-wide inputs", () => {
    const output = execFileSync(
      "pnpm",
      ["exec", "turbo", "run", "test", "--dry=json", "--filter=@kanna/kd"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        timeout: 30_000,
      },
    );
    const plan = JSON.parse(output) as TurboDryRun;
    const kdTestTask = plan.tasks.find((task) => task.taskId === "@kanna/kd#test");

    expect(kdTestTask).toBeDefined();
    if (!kdTestTask) return;

    expect(kdTestTask.resolvedTaskDefinition.cache).toBe(false);
  });

  it("hashes repository inputs consumed by cross-package test suites", () => {
    const output = execFileSync(
      "pnpm",
      [
        "exec",
        "turbo",
        "run",
        "test",
        "--dry=json",
        "--filter=@kanna/core",
        "--filter=@kanna/cli-contract",
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        timeout: 30_000,
      },
    );
    const plan = JSON.parse(output) as TurboDryRun;
    const coreTestTask = plan.tasks.find((task) => task.taskId === "@kanna/core#test");
    const cliContractTestTask = plan.tasks.find(
      (task) => task.taskId === "@kanna/cli-contract#test",
    );

    expect(coreTestTask).toBeDefined();
    expect(cliContractTestTask).toBeDefined();
    if (!coreTestTask || !cliContractTestTask) return;

    expect(Object.keys(coreTestTask.inputs)).toEqual(
      expect.arrayContaining([
        "../../.kanna/agents/implement/AGENT.md",
        "../../.kanna/workflows/schema.json",
      ]),
    );
    expect(Object.keys(cliContractTestTask.inputs)).toEqual(
      expect.arrayContaining([
        "../../.kanna/agents/implement/AGENT.md",
        "../../.kanna/workflows/schema.json",
        "../../packages/core/src/config/agent-providers.ts",
        "../../crates/kanna-tool-catalog/src/catalog.json",
      ]),
    );
    expect(
      Object.keys(cliContractTestTask.inputs).filter((input) =>
        input.includes("/node_modules/") || input.includes("/.turbo/"),
      ),
    ).toEqual([]);
  });

  it("keeps root unit tests bounded and heavy suites explicit", () => {
    const root = manifest("package.json");
    const remote = manifest("tests/remote-e2e/package.json");
    const fidelity = manifest("tests/tui-fidelity/package.json");

    expect(root.scripts?.test).toBe("turbo test --concurrency=2");
    expect(root.scripts?.["test:remote-e2e"]).toBe("./kd test remote-e2e");
    expect(root.scripts?.["test:tui-fidelity"])
      .toBe("pnpm --filter @kanna/tui-fidelity test:tui-fidelity");
    expect(remote.scripts?.test).toBe(
      "vitest run --maxWorkers=2 src/desktopPairing.test.ts src/harness.test.ts src/scriptedAgent.test.ts src/staging.test.ts src/vitestArgs.test.ts",
    );
    expect(remote.scripts?.["test:remote-e2e"]).toBe("tsx src/run.ts --dev");
    expect(fidelity.scripts).not.toHaveProperty("test");
    expect(fidelity.scripts?.["test:tui-fidelity"]).toBe("tsx src/run.ts");
  });

  it.each(vitestUnitPackages)("%s limits ordinary Vitest fan-out", (path) => {
    expect(manifest(path).scripts?.test).toContain("--maxWorkers=2");
  });

  it("uses the lockfile-managed Vitest binary for mobile", () => {
    const mobile = manifest("apps/mobile/package.json");
    expect(mobile.scripts?.test).toContain("pnpm exec vitest");
    expect(mobile.scripts?.test).not.toContain("pnpm dlx");
    expect(mobile.devDependencies?.vitest).toBe("^4.1.4");
  });

  it("keeps live agent CLI compatibility behind an explicit guarded script", () => {
    const root = manifest("package.json");
    const cliContract = manifest("tests/cli-contract/package.json");

    expect(root.scripts?.["test:agent-cli-compat"])
      .toBe("pnpm --filter @kanna/cli-contract test:agent-cli-compat");
    expect(root.scripts).not.toHaveProperty("test:cli-live");
    expect(cliContract.scripts?.test)
      .toBe("sh -c 'if [ \"$1\" = \"--\" ]; then shift; fi; exec vitest run --maxWorkers=2 \"$@\"' --");
    expect(cliContract.scripts?.["test:agent-cli-compat"])
      .toBe("KANNA_RUN_LIVE_AGENT_CLI_CONTRACTS=1 vitest run --config vitest.live.config.ts");
  });

  it("classifies every CLI contract as offline or explicitly live", () => {
    expect(existsSync(cliContractOfflineTestsDir)).toBe(true);
    expect(existsSync(cliContractLiveTestsDir)).toBe(true);
    if (!existsSync(cliContractOfflineTestsDir) || !existsSync(cliContractLiveTestsDir)) return;

    const unclassifiedTests = readdirSync(cliContractTestsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
      .map((entry) => entry.name);
    const liveTests = readdirSync(cliContractLiveTestsDir)
      .filter((name) => name.endsWith(".test.ts"))
      .sort();
    const offlineTests = readdirSync(cliContractOfflineTestsDir)
      .filter((name) => name.endsWith(".test.ts"))
      .sort();
    const classifiedTests = testFilesUnder(cliContractTestsDir).sort();

    expect(unclassifiedTests).toEqual([]);
    expect(liveTests).toEqual(expectedLiveCliContractTests);
    expect(offlineTests).toEqual(expectedOfflineCliContractTests);
    expect(classifiedTests).toEqual([
      ...expectedLiveCliContractTests.map((name) => `live/${name}`),
      ...expectedOfflineCliContractTests.map((name) => `offline/${name}`),
    ].sort());
  });

  it("keeps default CLI contracts free of external agent runners", () => {
    expect(existsSync(cliContractOfflineTestsDir)).toBe(true);
    if (!existsSync(cliContractOfflineTestsDir)) return;

    const offlineTests = readdirSync(cliContractOfflineTestsDir)
      .filter((name) => name.endsWith(".test.ts"));
    const externalRunnerImport = /from\s+["'][^"']*\/helpers\/(?:claude|copilot|codex|opencode)["']/;

    for (const name of offlineTests) {
      const source = readFileSync(resolve(cliContractOfflineTestsDir, name), "utf8");
      expect(source, `${name} imports an external agent runner`).not.toMatch(externalRunnerImport);
      expect(source, `${name} spawns a child process`).not.toContain("node:child_process");
    }
  });

  it("pins separate Vitest lanes and serializes the live lane", () => {
    const liveConfigPath = resolve(repoRoot, "tests/cli-contract/vitest.live.config.ts");
    expect(existsSync(liveConfigPath)).toBe(true);
    if (!existsSync(liveConfigPath)) return;

    const offlineConfig = readFileSync(
      resolve(repoRoot, "tests/cli-contract/vitest.config.ts"),
      "utf8",
    );
    const liveConfig = readFileSync(liveConfigPath, "utf8");

    expect(offlineConfig).toContain('include: ["tests/offline/**/*.test.ts"]');
    expect(offlineConfig).not.toContain("tests/live");
    expect(liveConfig).toContain('include: ["tests/live/**/*.test.ts"]');
    expect(liveConfig).toContain("testTimeout: 120_000");
    expect(liveConfig).toContain("hookTimeout: 30_000");
    expect(liveConfig).toContain("fileParallelism: false");
    expect(liveConfig).toContain("maxWorkers: 1");
  });

  it("guards every provider helper before binary discovery", () => {
    const guardPath = resolve(repoRoot, "tests/cli-contract/helpers/live-contract-guard.ts");
    expect(existsSync(guardPath)).toBe(true);
    if (!existsSync(guardPath)) return;

    const guard = readFileSync(guardPath, "utf8");
    expect(guard).toContain('process.env.KANNA_RUN_LIVE_AGENT_CLI_CONTRACTS !== "1"');
    expect(guard).toContain("Live agent CLI compatibility tests are disabled");

    for (const helper of ["claude.ts", "copilot.ts", "codex.ts", "opencode.ts"]) {
      const source = readFileSync(
        resolve(repoRoot, "tests/cli-contract/helpers", helper),
        "utf8",
      );
      expect(source).toContain(
        'import { assertLiveAgentCliContractsEnabled } from "./live-contract-guard";',
      );
      expect(source).toMatch(
        /export async function find\w+Binary\([^)]*\): Promise<string> \{\n  assertLiveAgentCliContractsEnabled\(\);/,
      );
    }
  });
});
