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
 */
export function useModalZIndex(): { zIndex: Ref<number>; bringToFront: () => void } {
  const zIndex = ref(BASE);

  function bringToFront() {
    remove(zIndex.value);
    zIndex.value = push();
  }

  onMounted(() => {
    zIndex.value = push();
  });

  onUnmounted(() => {
    remove(zIndex.value);
  });

  // KeepAlive: re-push on activate so a re-shown modal goes to the top
  onActivated(() => {
    zIndex.value = push();
  });

  onDeactivated(() => {
    remove(zIndex.value);
  });

  return { zIndex, bringToFront };
}
