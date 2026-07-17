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

export function shouldShowFloatingToolbar(
  taskDetailVisible: boolean,
  activeView: MobileView
): boolean {
  return !taskDetailVisible && activeView !== "desktops";
}

export function shouldShowTopBar(
  taskDetailVisible: boolean,
  activeView: MobileView
): boolean {
  return !taskDetailVisible && activeView !== "desktops";
}

export function getShellTitle(activeView: MobileView): string {
  switch (activeView) {
    case "desktops":
      return "Machines";
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
