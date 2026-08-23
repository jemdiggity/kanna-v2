export const TASK_COMPOSER_LINE_HEIGHT = 20;
export const TASK_COMPOSER_VERTICAL_PADDING = 20;
export const TASK_COMPOSER_MAX_LINES = 5;
export const TASK_COMPOSER_MIN_HEIGHT =
  TASK_COMPOSER_LINE_HEIGHT + TASK_COMPOSER_VERTICAL_PADDING;
export const TASK_COMPOSER_MAX_HEIGHT =
  TASK_COMPOSER_LINE_HEIGHT * TASK_COMPOSER_MAX_LINES +
  TASK_COMPOSER_VERTICAL_PADDING;

export function clampTaskComposerHeight(contentHeight: number): number {
  if (!Number.isFinite(contentHeight)) {
    return TASK_COMPOSER_MIN_HEIGHT;
  }

  return Math.min(
    TASK_COMPOSER_MAX_HEIGHT,
    Math.max(TASK_COMPOSER_MIN_HEIGHT, contentHeight)
  );
}

export function getTaskComposerExplicitLineHeight(value: string): number {
  const lineCount = value ? value.split("\n").length : 1;
  return clampTaskComposerHeight(
    lineCount * TASK_COMPOSER_LINE_HEIGHT + TASK_COMPOSER_VERTICAL_PADDING
  );
}

export const TASK_COMPOSER_TEXT_INPUT_PROPS = {
  blurOnSubmit: false,
  multiline: true,
  returnKeyType: "default",
  scrollEnabled: true
} as const;

export function appendComposerFileReference(
  current: string,
  reference: string
): string {
  return current ? `${current}\n${reference}` : reference;
}
