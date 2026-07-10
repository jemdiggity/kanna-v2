import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

interface PackageManifest {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
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
  "tools/kd/package.json",
];

describe("test orchestration", () => {
  it("keeps root unit tests bounded and heavy suites explicit", () => {
    const root = manifest("package.json");
    const remote = manifest("tests/remote-e2e/package.json");
    const fidelity = manifest("tests/tui-fidelity/package.json");

    expect(root.scripts?.test).toBe("turbo test --concurrency=2");
    expect(root.scripts?.["test:remote-e2e"]).toBe("./kd test remote-e2e");
    expect(root.scripts?.["test:tui-fidelity"])
      .toBe("pnpm --filter @kanna/tui-fidelity test:tui-fidelity");
    expect(remote.scripts).not.toHaveProperty("test");
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
});
