import type { AgentProvider } from "../types/kanna";

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

function assertNever(provider: never): never {
  throw new Error(`Unhandled agent provider: ${String(provider)}`);
}

export function getAgentPermissionFlags(
  provider: AgentProvider,
  permissionMode?: string,
): string[] {
  const normalizedPermissionMode = normalizePermissionMode(permissionMode);

  switch (provider) {
    case "claude":
      if (shouldUseYoloPermissionDefaults(permissionMode)) {
        return ["--dangerously-skip-permissions"];
      }
      return [`--permission-mode ${normalizedPermissionMode}`];
    case "copilot":
      // Copilot doesn't have a direct generic-permission equivalent for acceptEdits,
      // so every mode currently collapses to its yolo flag.
      return ["--yolo"];
    case "codex":
      // `--full-auto` was removed from the interactive codex CLI, which now
      // rejects it as an unexpected argument. Keep this in step with the Rust
      // source of truth in crates/kanna-server/src/task_creator/commands.rs.
      return shouldUseYoloPermissionDefaults(permissionMode)
        ? ["--yolo"]
        : ["--sandbox workspace-write"];
    case "opencode":
    case "antigravity":
      return shouldUseYoloPermissionDefaults(permissionMode)
        ? ["--dangerously-skip-permissions"]
        : [];
    default:
      return assertNever(provider);
  }
}
