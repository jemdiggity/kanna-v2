import { ref, computed } from "vue";

const MAX_STACK_SIZE = 50;
const DWELL_THRESHOLD_MS = 1000;

export function createNavigationHistory() {
  const backStack = ref<string[]>([]);
  const forwardStack = ref<string[]>([]);
  let lastSelectionTime = Date.now();

  const canGoBack = computed(() => backStack.value.length > 0);
  const canGoForward = computed(() => forwardStack.value.length > 0);

  function recordNavigation(previousId: string | null) {
    if (!previousId) return;
    const now = Date.now();
    const dwellTime = now - lastSelectionTime;
    lastSelectionTime = now;
    // Skip tasks the user passed through transiently
    if (dwellTime < DWELL_THRESHOLD_MS) return;
    // Suppress duplicate consecutive entries
    if (backStack.value.length > 0 && backStack.value[backStack.value.length - 1] === previousId) return;
    backStack.value.push(previousId);
    if (backStack.value.length > MAX_STACK_SIZE) {
      backStack.value.splice(0, backStack.value.length - MAX_STACK_SIZE);
    }
    forwardStack.value = [];
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

  return { recordNavigation, goBack, goForward, canGoBack, canGoForward };
}
