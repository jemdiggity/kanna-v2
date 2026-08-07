import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const PROVIDER_NAMES = ["claude", "copilot", "codex", "opencode"] as const;

/**
 * `run.ts` forces every real suite onto the default provider
 * (`KANNA_E2E_REAL_AGENT_PROVIDER`, opencode). A filename that names a provider
 * therefore claims something the runner does not give it — unless the suite
 * pins that provider itself, which overrides the default. So the rule is not
 * "no provider names"; it is "a provider name in the filename must be backed by
 * an explicit pin in the suite".
 */
const PROVIDER_PIN_PATTERN = (provider: string) =>
  new RegExp(`\\bagent_?[Pp]rovider\\b\\s*[:=]\\s*["']?${provider}\\b`);

function providersInFilename(name: string): string[] {
  return PROVIDER_NAMES.filter((provider) => name.toLowerCase().includes(provider));
}

describe("default real E2E suite naming", () => {
  it("only names a provider in a real suite filename when the suite pins that provider", async () => {
    const realDir = join(dirname(fileURLToPath(import.meta.url)), "real");
    const entries = await readdir(realDir, { withFileTypes: true });
    const suites = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
      .map((entry) => entry.name);

    const unpinned: string[] = [];
    for (const name of suites) {
      for (const provider of providersInFilename(name)) {
        const source = await readFile(join(realDir, name), "utf8");
        if (!PROVIDER_PIN_PATTERN(provider).test(source)) {
          unpinned.push(`${name} (names "${provider}" but never pins it)`);
        }
      }
    }

    expect(unpinned).toEqual([]);
  });
});
