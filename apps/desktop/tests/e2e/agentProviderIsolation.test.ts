import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_PROVIDER_SPECS } from "@kanna/agent-protocol";
import {
  buildAgentProviderIsolationEnv,
  composeInstanceStartEnv,
} from "./agentProviderIsolation";

describe("agent provider isolation", () => {
  it("composes provider isolation independently from CLI version fixtures", () => {
    expect(composeInstanceStartEnv({
      baseEnv: { BASE: "base", PATH: "/authenticated" },
      runtimeEnv: { RUNTIME: "runtime" },
      agentCliVersionEnv: { KANNA_E2E_AGENT_CLI_VERSION_CODEX: "fixture" },
      agentProviderIsolationEnv: {
        PATH: "/isolated",
        ZDOTDIR: "/isolated/zsh",
      },
      useAgentCliFixtures: false,
      isolateAgentProviders: true,
    })).toEqual({
      BASE: "base",
      RUNTIME: "runtime",
      PATH: "/isolated",
      ZDOTDIR: "/isolated/zsh",
    });

    expect(composeInstanceStartEnv({
      baseEnv: { BASE: "base" },
      runtimeEnv: { RUNTIME: "runtime" },
      agentCliVersionEnv: { KANNA_E2E_AGENT_CLI_VERSION_CODEX: "fixture" },
      agentProviderIsolationEnv: { PATH: "/isolated" },
      useAgentCliFixtures: true,
      isolateAgentProviders: false,
    })).toEqual({
      BASE: "base",
      RUNTIME: "runtime",
      KANNA_E2E_AGENT_CLI_VERSION_CODEX: "fixture",
    });
  });

  it("prepends executable provider stubs and excludes authenticated provider paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-provider-isolation-"));
    try {
      const authenticatedBin = join(root, "authenticated-bin");
      const ordinaryBin = join(root, "ordinary-bin");
      await mkdir(authenticatedBin);
      await mkdir(ordinaryBin);
      await writeExecutable(join(authenticatedBin, "codex"));
      await writeExecutable(join(authenticatedBin, "git"));
      await writeExecutable(join(ordinaryBin, "sh"));

      const env = await buildAgentProviderIsolationEnv(
        join(root, "fixture"),
        [authenticatedBin, ordinaryBin].join(delimiter),
      );
      const pathEntries = env.PATH.split(delimiter);
      const stubRoot = pathEntries[0];

      for (const { executable } of AGENT_PROVIDER_SPECS) {
        await expect(
          access(join(stubRoot, executable), constants.X_OK),
        ).resolves.toBeUndefined();
      }
      expect(pathEntries).not.toContain(authenticatedBin);
      expect(pathEntries).toContain(ordinaryBin);
      await expect(
        readFile(join(pathEntries[1], "codex"), "utf8"),
      ).rejects.toThrow();
      await expect(
        readFile(join(pathEntries[1], "git"), "utf8"),
      ).resolves.toContain("exit 0");
      await expect(
        readFile(join(env.ZDOTDIR, ".zshrc"), "utf8"),
      ).resolves.toContain(`export PATH='${env.PATH}'`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function writeExecutable(path: string): Promise<void> {
  await writeFile(path, "#!/bin/sh\nexit 0\n");
  await chmod(path, 0o755);
}
