export const DEFAULT_TERMINAL_BOTTOM_INSET = 132;
const TERMINAL_READING_GAP = 8;
const SELECTION_TOOLBAR_CHROME_GAP = 12;
// Approximates the collapsed top chrome (16px offset + title chip) for the
// window before the header reports its measured layout.
const FALLBACK_TOP_CHROME_BOTTOM = 60;

// The fullscreen terminal underlays the floating task chrome (back button +
// title chip), which paints above it as a later sibling. The selection
// toolbar must clear the chrome's bottom edge or the title chip covers it and
// swallows its taps.
export function getTerminalSelectionToolbarTop(
  topChromeBottom: number | null
): number {
  const resolvedBottom =
    topChromeBottom !== null &&
    Number.isFinite(topChromeBottom) &&
    topChromeBottom > 0
      ? topChromeBottom
      : FALLBACK_TOP_CHROME_BOTTOM;
  return Math.ceil(resolvedBottom + SELECTION_TOOLBAR_CHROME_GAP);
}

export function getTerminalBottomInset(
  screenHeight: number,
  composerTop: number | null
): number {
  if (
    !Number.isFinite(screenHeight) ||
    screenHeight <= 0 ||
    composerTop === null ||
    !Number.isFinite(composerTop)
  ) {
    return DEFAULT_TERMINAL_BOTTOM_INSET;
  }

  return Math.max(
    0,
    Math.ceil(screenHeight - composerTop + TERMINAL_READING_GAP)
  );
}
