const RESTING_COMPOSER_BOTTOM = 14;
const KEYBOARD_COMPOSER_GAP = 8;

export function getComposerBottomOffset(keyboardHeight: number): number {
  if (keyboardHeight <= 0) {
    return RESTING_COMPOSER_BOTTOM;
  }

  return keyboardHeight + KEYBOARD_COMPOSER_GAP;
}
