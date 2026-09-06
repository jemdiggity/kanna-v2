export const TABLET_WORKSPACE_BREAKPOINT = 900;
export const TABLET_SIDEBAR_MIN_WIDTH = 280;
export const TABLET_SIDEBAR_MAX_WIDTH = 360;

export interface TabletWorkspaceLayout {
  isWide: boolean;
  sidebarWidth: number;
  workspaceWidth: number;
}

export function resolveTabletWorkspaceLayout(
  viewportWidth: number
): TabletWorkspaceLayout {
  const safeWidth = Math.max(0, viewportWidth);
  if (safeWidth < TABLET_WORKSPACE_BREAKPOINT) {
    return {
      isWide: false,
      sidebarWidth: 0,
      workspaceWidth: safeWidth
    };
  }

  const sidebarWidth = Math.min(
    TABLET_SIDEBAR_MAX_WIDTH,
    Math.max(TABLET_SIDEBAR_MIN_WIDTH, Math.round(safeWidth * 0.3))
  );
  return {
    isWide: true,
    sidebarWidth,
    workspaceWidth: safeWidth - sidebarWidth
  };
}
