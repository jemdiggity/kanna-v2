import type { TaskSummary } from "../lib/api/types";
import type { TaskTerminalStatus } from "../state/sessionStore";

export interface TaskWorkspaceModel {
  stageLabel: string;
  title: string;
  isTerminalHealthy: boolean;
  overlayLabel: string | null;
  isComposerDisabled: boolean;
  chromeStyle: "floating";
  terminalLayout: "fullscreen";
  titlePresentation: "chip";
}

interface BuildTaskWorkspaceModelOptions {
  task: TaskSummary;
  terminalStatus: TaskTerminalStatus;
  terminalErrorMessage?: string | null;
}

export function buildTaskWorkspaceModel({
  task,
  terminalStatus,
  terminalErrorMessage = null
}: BuildTaskWorkspaceModelOptions): TaskWorkspaceModel {
  return {
    stageLabel: task.stage ?? "unknown",
    title: task.title,
    isTerminalHealthy: terminalStatus === "live",
    overlayLabel: getOverlayLabel(terminalStatus, terminalErrorMessage),
    isComposerDisabled: terminalStatus !== "live",
    chromeStyle: "floating",
    terminalLayout: "fullscreen",
    titlePresentation: "chip"
  };
}

function getOverlayLabel(
  status: TaskTerminalStatus,
  terminalErrorMessage: string | null
): string | null {
  switch (status) {
    case "connecting":
      return "Connecting";
    case "closed":
      return "Offline";
    case "error":
      return terminalErrorMessage?.trim() || "Error";
    case "idle":
      return "Connecting";
    case "live":
    default:
      return null;
  }
}
