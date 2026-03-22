import { type Ref, onMounted, onUnmounted } from "vue";

const LINE = 40;

function isInputTarget(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement;
  return (
    t instanceof HTMLInputElement ||
    t instanceof HTMLTextAreaElement ||
    t.isContentEditable
  );
}

function noMods(e: KeyboardEvent): boolean {
  return !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
}

/**
 * Registers less-style scroll key bindings on the given scrollable element.
 * Auto-cleans on onUnmounted.
 *
 * @param scrollRef - Ref to the scrollable DOM element
 * @param extraHandler - Optional handler for component-specific keys.
 *   Called first; return true to indicate the key was handled (skips scroll logic).
 * @param onClose - Called when `q` is pressed.
 */
export function useLessScroll(
  scrollRef: Ref<HTMLElement | null>,
  options: {
    extraHandler?: (e: KeyboardEvent) => boolean;
    onClose?: () => void;
  } = {}
) {
  function onKeydown(e: KeyboardEvent) {
    if (isInputTarget(e)) return;

    // Let the component handle its own keys first
    if (options.extraHandler?.(e)) return;

    const el = scrollRef.value;
    if (!el) return;

    const page = el.clientHeight;
    const half = page / 2;

    // q — close
    if (e.key === "q" && noMods(e)) {
      e.preventDefault();
      options.onClose?.();
      return;
    }

    // Scroll bindings
    let handled = true;
    if ((e.key === "j" && noMods(e)) || (e.key === "ArrowDown" && noMods(e))) {
      el.scrollTop += LINE;
    } else if ((e.key === "k" && noMods(e)) || (e.key === "ArrowUp" && noMods(e))) {
      el.scrollTop -= LINE;
    } else if (
      (e.key === "f" && noMods(e)) ||
      (e.key === " " && noMods(e)) ||
      (e.key === "PageDown" && noMods(e))
    ) {
      el.scrollTop += page;
    } else if (
      (e.key === "b" && noMods(e)) ||
      (e.key === "PageUp" && noMods(e))
    ) {
      el.scrollTop -= page;
    } else if (e.key === "d" && noMods(e)) {
      el.scrollTop += half;
    } else if (e.key === "u" && noMods(e)) {
      el.scrollTop -= half;
    } else if (e.key === "g" && noMods(e)) {
      el.scrollTop = 0;
    } else if (e.key === "G" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      el.scrollTop = el.scrollHeight;
    } else {
      handled = false;
    }

    if (handled) e.preventDefault();
  }

  onMounted(() => window.addEventListener("keydown", onKeydown));
  onUnmounted(() => window.removeEventListener("keydown", onKeydown));
}
