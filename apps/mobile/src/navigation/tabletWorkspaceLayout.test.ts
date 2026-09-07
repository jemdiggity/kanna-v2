import { describe, expect, it } from "vitest";
import {
  TABLET_WORKSPACE_BREAKPOINT,
  resolveTabletWorkspaceLayout
} from "./tabletWorkspaceLayout";

describe("resolveTabletWorkspaceLayout", () => {
  it("keeps iPhone and narrow split-view windows on the existing layout", () => {
    expect(resolveTabletWorkspaceLayout(390)).toEqual({
      isWide: false,
      sidebarWidth: 0,
      workspaceWidth: 390
    });
    expect(resolveTabletWorkspaceLayout(TABLET_WORKSPACE_BREAKPOINT - 1).isWide)
      .toBe(false);
  });

  it("projects a bounded sidebar and the remaining tablet workspace", () => {
    expect(resolveTabletWorkspaceLayout(1024)).toEqual({
      isWide: true,
      sidebarWidth: 307,
      workspaceWidth: 717
    });
    expect(resolveTabletWorkspaceLayout(1366)).toEqual({
      isWide: true,
      sidebarWidth: 360,
      workspaceWidth: 1006
    });
  });
});
