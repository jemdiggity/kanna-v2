import type { AgentProvider } from "@kanna/db";

export function normalizePermissionMode(permissionMode?: string): string | undefined {
  if (!permissionMode || permissionMode === "default") {
    return undefined;
  }

  return permissionMode;
}

function shouldUseYoloPermissionDefaults(permissionMode?: string): boolean {
  const normalizedPermissionMode = normalizePermissionMode(permissionMode);
  return !normalizedPermissionMode || normalizedPermissionMode === "dontAsk";
}

export function getAgentPermissionFlags(
  provider: AgentProvider,
  permissionMode?: string,
): string[] {
  const normalizedPermissionMode = normalizePermissionMode(permissionMode);

  if (provider === "claude") {
    if (shouldUseYoloPermissionDefaults(permissionMode)) {
      return ["--dangerously-skip-permissions"];
    }

    return [`--permission-mode ${normalizedPermissionMode}`];
  }

  if (provider === "copilot") {
    // Copilot doesn't have a direct generic-permission equivalent for acceptEdits,
    // so every mode currently collapses to its yolo flag.
    return ["--yolo"];
  }

  if (provider === "opencode") {
    return shouldUseYoloPermissionDefaults(permissionMode)
      ? ["--dangerously-skip-permissions"]
      : [];
  }

  if (shouldUseYoloPermissionDefaults(permissionMode)) {
    return ["--yolo"];
  }

  return ["--full-auto"];
}
