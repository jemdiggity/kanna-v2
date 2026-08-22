export const TASK_COMPOSER_MIN_HEIGHT = 40;
export const TASK_COMPOSER_MAX_HEIGHT = 120;

export function clampTaskComposerHeight(contentHeight: number): number {
  if (!Number.isFinite(contentHeight)) {
    return TASK_COMPOSER_MIN_HEIGHT;
  }

  return Math.min(
    TASK_COMPOSER_MAX_HEIGHT,
    Math.max(TASK_COMPOSER_MIN_HEIGHT, contentHeight)
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
