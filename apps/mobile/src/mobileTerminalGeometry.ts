const MINIMUM_MOBILE_TERMINAL_COLS = 80;
const MINIMUM_MOBILE_TERMINAL_ROWS = 48;
const ESTIMATED_TERMINAL_CELL_WIDTH_PX = 8;
const ESTIMATED_TERMINAL_CELL_HEIGHT_PX = 17;
const MOBILE_TERMINAL_COMPOSER_AND_CHROME_INSET_PX = 132;

export interface MobileTerminalGeometry {
  readonly cols: number;
  readonly rows: number;
}

export interface MobileTerminalViewport {
  width: number;
  height: number;
}

export const DEFAULT_MOBILE_TERMINAL_GEOMETRY: MobileTerminalGeometry = Object.freeze({
  cols: MINIMUM_MOBILE_TERMINAL_COLS,
  rows: MINIMUM_MOBILE_TERMINAL_ROWS
});

export function resolveMobileTerminalGeometry(
  viewport: MobileTerminalViewport | null | undefined
): MobileTerminalGeometry {
  if (
    !viewport ||
    !Number.isFinite(viewport.width) ||
    viewport.width <= 0 ||
    !Number.isFinite(viewport.height) ||
    viewport.height <= 0
  ) {
    return {
      cols: MINIMUM_MOBILE_TERMINAL_COLS,
      rows: MINIMUM_MOBILE_TERMINAL_ROWS
    };
  }

  return {
    cols: Math.max(
      MINIMUM_MOBILE_TERMINAL_COLS,
      Math.floor(viewport.width / ESTIMATED_TERMINAL_CELL_WIDTH_PX)
    ),
    rows: Math.max(
      MINIMUM_MOBILE_TERMINAL_ROWS,
      Math.floor(
        (viewport.height - MOBILE_TERMINAL_COMPOSER_AND_CHROME_INSET_PX) /
          ESTIMATED_TERMINAL_CELL_HEIGHT_PX
      )
    )
  };
}
