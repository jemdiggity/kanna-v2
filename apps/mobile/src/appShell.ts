import type { ConnectionState, MobileView } from "./state/sessionStore";

export function isTaskDetailVisible(
  selectedTaskId: string | null,
  activeView: MobileView
): boolean {
  return selectedTaskId !== null && activeView !== "more";
}

export function shouldShowFloatingToolbar(
  connectionState: ConnectionState,
  selectedTaskId: string | null,
  activeView: MobileView
): boolean {
  return connectionState === "connected" && !isTaskDetailVisible(selectedTaskId, activeView);
}

export function getShellTitle(activeView: MobileView): string {
  switch (activeView) {
    case "desktops":
      return "Desktops";
    case "recent":
      return "Activity";
    case "search":
      return "Search";
    case "more":
      return "More";
    case "tasks":
    default:
      return "Tasks";
  }
}
