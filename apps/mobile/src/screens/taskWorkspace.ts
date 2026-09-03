import type { TaskSummary } from "../lib/api/types";
import type {
  TaskCreationPhase,
  TaskTerminalStatus
} from "../state/sessionStore";

export interface TaskWorkspaceModel {
  stageLabel: string;
  title: string;
  isTerminalHealthy: boolean;
  overlayLabel: string | null;
  isComposerDisabled: boolean;
  canRecoverTaskCreation: boolean;
  chromeStyle: "floating";
  terminalLayout: "fullscreen";
  titlePresentation: "chip";
}

interface BuildTaskWorkspaceModelOptions {
  task: TaskSummary;
  terminalStatus: TaskTerminalStatus;
  terminalErrorMessage?: string | null;
  taskCreationPhase?: TaskCreationPhase;
}

export function buildTaskWorkspaceModel({
  task,
  terminalStatus,
  terminalErrorMessage = null,
  taskCreationPhase = "idle"
}: BuildTaskWorkspaceModelOptions): TaskWorkspaceModel {
  const creationOverlayLabel = getCreationOverlayLabel(taskCreationPhase);

  return {
    stageLabel: task.stage ?? "unknown",
    title: task.title,
    isTerminalHealthy:
      taskCreationPhase === "idle" && terminalStatus === "live",
    overlayLabel:
      creationOverlayLabel ??
      getOverlayLabel(terminalStatus, terminalErrorMessage),
    isComposerDisabled:
      taskCreationPhase !== "idle" || terminalStatus !== "live",
    canRecoverTaskCreation: taskCreationPhase === "uncertain",
    chromeStyle: "floating",
    terminalLayout: "fullscreen",
    titlePresentation: "chip"
  };
}

function getCreationOverlayLabel(phase: TaskCreationPhase): string | null {
  switch (phase) {
    case "pending":
      return "Creating task";
    case "recovering":
      return "Recovering task";
    case "uncertain":
      return "Task creation interrupted";
    case "idle":
    default:
      return null;
  }
}

function getOverlayLabel(
  status: TaskTerminalStatus,
  terminalErrorMessage: string | null
): string | null {
  switch (status) {
    case "connecting":
      return "Connecting";
    case "restarting":
      return "Restarting session";
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
