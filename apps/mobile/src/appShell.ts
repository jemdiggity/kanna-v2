import type { ConnectionState, MobileView } from "./state/sessionStore";

export function isTaskDetailVisible(
  connectionState: ConnectionState,
  hasSelectedTask: boolean,
  activeView: MobileView
): boolean {
  return (
    connectionState === "connected" &&
    hasSelectedTask &&
    activeView !== "more"
  );
}

export function shouldShowFloatingToolbar(taskDetailVisible: boolean): boolean {
  return !taskDetailVisible;
}

export function shouldShowTopBar(taskDetailVisible: boolean): boolean {
  return !taskDetailVisible;
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
