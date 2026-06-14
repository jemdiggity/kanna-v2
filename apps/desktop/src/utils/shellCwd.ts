import { invoke } from "../invoke";

export interface ResolvedShellCwd {
  cwd: string;
  fellBack: boolean;
}

export async function isReadableDirectory(path: string): Promise<boolean> {
  try {
    await invoke<string[]>("list_dir", { path });
    return true;
  } catch (error) {
    console.debug("[shell-cwd] directory is not readable:", { path, error });
    return false;
  }
}

export async function resolveShellSpawnCwd(
  preferredCwd: string,
  fallbackCwd?: string | null,
): Promise<ResolvedShellCwd> {
  if (await isReadableDirectory(preferredCwd)) {
    return { cwd: preferredCwd, fellBack: false };
  }

  if (fallbackCwd && fallbackCwd !== preferredCwd && await isReadableDirectory(fallbackCwd)) {
    return { cwd: fallbackCwd, fellBack: true };
  }

  throw new Error(`shell cwd is not readable: ${preferredCwd}`);
}
