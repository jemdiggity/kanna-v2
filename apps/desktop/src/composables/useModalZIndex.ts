import { ref, onMounted, onUnmounted, onActivated, onDeactivated } from "vue";
import type { Ref } from "vue";

const BASE = 1000;
let nextZ = BASE;
const stack = ref<number[]>([]);

function push(): number {
  const z = nextZ++;
  stack.value.push(z);
  return z;
}

function remove(z: number): void {
  stack.value = stack.value.filter((v) => v !== z);
}

/** Returns true if the given z-index is the highest in the modal stack. */
export function isTopModal(z: number): boolean {
  const s = stack.value;
  return s.length > 0 && s[s.length - 1] === z;
}

/**
 * Auto-incrementing z-index for modal overlays.
 * The most recently opened modal gets the highest z-index.
 * Handles both normal mount/unmount and KeepAlive activate/deactivate.
 *
 * Returns { zIndex, bringToFront } — call bringToFront() to move an
 * already-open modal to the top of the stack without remounting.
 *
 * `enabled: false` is for a view component rendered inline — as a main-area
 * tab rather than an overlay. It keeps the base z-index and never joins the
 * stack, because a tab that is merely open is not "on top of" the modals a
 * user opened over it, and counting it as such breaks `isTopModal`.
 */
export function useModalZIndex(
  options?: { enabled?: boolean },
): { zIndex: Ref<number>; bringToFront: () => void } {
  const enabled = options?.enabled !== false;
  const zIndex = ref(BASE);

  function bringToFront() {
    if (!enabled) return;
    remove(zIndex.value);
    zIndex.value = push();
  }

  onMounted(() => {
    if (!enabled) return;
    zIndex.value = push();
  });

  onUnmounted(() => {
    if (!enabled) return;
    remove(zIndex.value);
  });

  // KeepAlive: re-push on activate so a re-shown modal goes to the top
  onActivated(() => {
    if (!enabled) return;
    zIndex.value = push();
  });

  onDeactivated(() => {
    if (!enabled) return;
    remove(zIndex.value);
  });

  return { zIndex, bringToFront };
}
