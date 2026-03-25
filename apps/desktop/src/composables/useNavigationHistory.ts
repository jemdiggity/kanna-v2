import { ref, computed } from "vue";

const MAX_STACK_SIZE = 50;
const DWELL_THRESHOLD_MS = 1000;

export function createNavigationHistory() {
  const backStack = ref<string[]>([]);
  const forwardStack = ref<string[]>([]);
  let lastSelectionTime = Date.now();

  const canGoBack = computed(() => backStack.value.length > 0);
  const canGoForward = computed(() => forwardStack.value.length > 0);

  /**
   * Select a new item, recording the previous one in history
   * if dwell time was met. Returns the new ID (always `newId`).
   */
  function select(newId: string, previousId: string | null) {
    if (previousId && previousId !== newId) {
      const now = Date.now();
      const dwellTime = now - lastSelectionTime;
      if (dwellTime >= DWELL_THRESHOLD_MS) {
        // Suppress duplicate consecutive entries
        if (backStack.value[backStack.value.length - 1] !== previousId) {
          backStack.value.push(previousId);
          if (backStack.value.length > MAX_STACK_SIZE) {
            backStack.value.splice(0, backStack.value.length - MAX_STACK_SIZE);
          }
        }
        forwardStack.value = [];
      }
    }
    lastSelectionTime = Date.now();
  }

  function goBack(currentId: string, validIds?: Set<string>): string | null {
    while (backStack.value.length > 0) {
      const taskId = backStack.value.pop()!;
      if (validIds && !validIds.has(taskId)) continue;
      forwardStack.value.push(currentId);
      lastSelectionTime = Date.now();
      return taskId;
    }
    return null;
  }

  function goForward(currentId: string, validIds?: Set<string>): string | null {
    while (forwardStack.value.length > 0) {
      const taskId = forwardStack.value.pop()!;
      if (validIds && !validIds.has(taskId)) continue;
      backStack.value.push(currentId);
      lastSelectionTime = Date.now();
      return taskId;
    }
    return null;
  }

  return { select, goBack, goForward, canGoBack, canGoForward };
}
