export const KD_CACHE_ROOT_MARKER: string;

export interface KdRuntime {
  nodeMajor: string;
  platform: string;
  arch: string;
}

export function validateKdInstallation(
  entryDir: string,
  identity: string,
  runtime: KdRuntime
): boolean;
