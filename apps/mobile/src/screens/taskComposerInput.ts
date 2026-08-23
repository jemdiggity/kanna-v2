export const TASK_COMPOSER_LINE_HEIGHT = 20;
export const TASK_COMPOSER_VERTICAL_PADDING = 20;
export const TASK_COMPOSER_MAX_LINES = 5;
export const TASK_COMPOSER_MIN_HEIGHT =
  TASK_COMPOSER_LINE_HEIGHT + TASK_COMPOSER_VERTICAL_PADDING;
export const TASK_COMPOSER_MAX_HEIGHT =
  TASK_COMPOSER_LINE_HEIGHT * TASK_COMPOSER_MAX_LINES +
  TASK_COMPOSER_VERTICAL_PADDING;

export function shouldTaskComposerScroll(contentHeight: number): boolean {
  return (
    Number.isFinite(contentHeight) && contentHeight > TASK_COMPOSER_MAX_HEIGHT
  );
}

export const TASK_COMPOSER_TEXT_INPUT_PROPS = {
  blurOnSubmit: false,
  multiline: true,
  returnKeyType: "default"
} as const;

export function appendComposerFileReference(
  current: string,
  reference: string
): string {
  return current ? `${current}\n${reference}` : reference;
}
