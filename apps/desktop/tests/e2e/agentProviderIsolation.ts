import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { delimiter, join } from "node:path";
import { AGENT_PROVIDER_SPECS } from "@kanna/agent-protocol";

export interface ComposeInstanceStartEnvInput {
  baseEnv: Record<string, string>;
  runtimeEnv: Record<string, string>;
  agentCliVersionEnv: Record<string, string>;
  agentProviderIsolationEnv: Record<string, string>;
  useAgentCliFixtures: boolean;
  isolateAgentProviders: boolean;
}

export function composeInstanceStartEnv(
  input: ComposeInstanceStartEnvInput,
): Record<string, string> {
  return {
    ...input.baseEnv,
    ...input.runtimeEnv,
    ...(input.useAgentCliFixtures ? input.agentCliVersionEnv : {}),
    ...(input.isolateAgentProviders ? input.agentProviderIsolationEnv : {}),
  };
}

export async function buildAgentProviderIsolationEnv(
  fixtureRoot: string,
  sourcePath = process.env.PATH ?? "",
): Promise<Record<string, string>> {
  const providerExecutables = new Set(
    AGENT_PROVIDER_SPECS.map(({ executable }) => executable),
  );
  const sanitizedPathEntries: string[] = [];
  const pathRoot = join(fixtureRoot, "path");
  const stubRoot = join(fixtureRoot, "provider-stubs");
  const zshStartupDir = join(fixtureRoot, "zsh");
  await mkdir(pathRoot, { recursive: true });
  await mkdir(stubRoot, { recursive: true });
  await mkdir(zshStartupDir, { recursive: true });

  for (const executable of providerExecutables) {
    const stubPath = join(stubRoot, executable);
    await writeFile(
      stubPath,
      "#!/bin/sh\n" +
        "echo 'Kanna E2E blocked an isolated agent provider launch' >&2\n" +
        "exit 127\n",
    );
    await chmod(stubPath, 0o755);
  }
  sanitizedPathEntries.push(stubRoot);

  for (const [index, entry] of sourcePath.split(delimiter).entries()) {
    if (!entry) continue;
    const containsProvider = (await Promise.all(
      [...providerExecutables].map(
        (executable) => isExecutable(join(entry, executable)),
      ),
    )).some(Boolean);
    if (!containsProvider) {
      sanitizedPathEntries.push(entry);
      continue;
    }

    const mirror = join(pathRoot, String(index));
    await mkdir(mirror, { recursive: true });
    const entries = await readdir(entry, { withFileTypes: true }).catch(() => []);
    for (const candidate of entries) {
      if (providerExecutables.has(candidate.name)) continue;
      const source = join(entry, candidate.name);
      if (!await isExecutable(source)) continue;
      await symlink(source, join(mirror, candidate.name));
    }
    sanitizedPathEntries.push(mirror);
  }

  const sanitizedPath = sanitizedPathEntries.join(delimiter);
  const shellPath = sanitizedPath.replaceAll("'", "'\\''");
  const zshPathExport = `export PATH='${shellPath}'\n`;
  await writeFile(join(zshStartupDir, ".zprofile"), zshPathExport);
  await writeFile(join(zshStartupDir, ".zshrc"), zshPathExport);

  return {
    PATH: sanitizedPath,
    SHELL: "/bin/zsh",
    ZDOTDIR: zshStartupDir,
  };
}

async function isExecutable(path: string): Promise<boolean> {
  return await access(path, constants.X_OK).then(() => true).catch(() => false);
}
