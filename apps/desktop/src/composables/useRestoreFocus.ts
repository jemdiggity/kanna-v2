import { watch, nextTick, type Ref } from "vue";

/**
 * Saves document.activeElement when `isOpen` becomes true,
 * restores focus to that element when `isOpen` becomes false.
 */
export function useRestoreFocus(isOpen: Ref<boolean>) {
  let saved: HTMLElement | null = null;

  watch(isOpen, (open) => {
    if (open) {
      saved = document.activeElement as HTMLElement | null;
    } else if (saved) {
      const el = saved;
      saved = null;
      nextTick(() => el.focus());
    }
  });
}
