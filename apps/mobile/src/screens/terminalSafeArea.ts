export const DEFAULT_TERMINAL_BOTTOM_INSET = 132;
const TERMINAL_READING_GAP = 8;

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
