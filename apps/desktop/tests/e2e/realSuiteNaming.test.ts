import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const PROVIDER_NAME_PATTERN = /(claude|copilot|codex|opencode)/i;

describe("default real E2E suite naming", () => {
  it("does not use provider names in top-level real suite filenames", async () => {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const realDir = join(currentDir, "real");
    const entries = await readdir(realDir, { withFileTypes: true });

    const providerNamedFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
      .map((entry) => entry.name)
      .filter((name) => PROVIDER_NAME_PATTERN.test(name));

    expect(providerNamedFiles).toEqual([]);
  });
});
