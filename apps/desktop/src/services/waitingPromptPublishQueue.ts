export interface WaitingPromptPublishQueue {
  seed(taskId: string, value: string | null): void;
  schedule(taskId: string, value: string): void;
  cancel(taskId: string): void;
  dispose(): void;
}

export function createWaitingPromptPublishQueue(options: {
  delayMs: number;
  retryDelayMs?: number | null;
  publish(taskId: string, value: string): Promise<void>;
  onError?(error: unknown): void;
}): WaitingPromptPublishQueue {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const versions = new Map<string, number>();
  const lastPublished = new Map<string, string | null>();
  const desiredValues = new Map<string, string | null>();
  const inFlight = new Map<string, { value: string; version: number }>();

  const nextVersion = (taskId: string) => {
    const version = (versions.get(taskId) ?? 0) + 1;
    versions.set(taskId, version);
    return version;
  };

  const clearTimer = (taskId: string) => {
    const timer = timers.get(taskId);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(taskId);
  };

  const cancel = (taskId: string) => {
    clearTimer(taskId);
    nextVersion(taskId);
    desiredValues.delete(taskId);
  };

  function ensureDesiredValueIsScheduled(taskId: string): void {
    if (timers.has(taskId) || inFlight.has(taskId)) return;
    const desiredValue = desiredValues.get(taskId);
    const version = versions.get(taskId);
    if (
      desiredValue === undefined
      || desiredValue === null
      || version === undefined
      || lastPublished.get(taskId) === desiredValue
    ) {
      return;
    }
    schedulePublish(taskId, desiredValue, version, options.delayMs, true);
  }

  function schedulePublish(
    taskId: string,
    value: string,
    version: number,
    delayMs: number,
    mayRetry: boolean,
  ): void {
    timers.set(taskId, setTimeout(() => {
      timers.delete(taskId);
      if (
        versions.get(taskId) !== version
        || desiredValues.get(taskId) !== value
        || lastPublished.get(taskId) === value
      ) {
        return;
      }
      if (inFlight.has(taskId)) {
        // The in-flight completion reconciles whatever value is currently
        // desired. Keeping only one write per task in flight also makes its
        // successful completion the authoritative remote ordering.
        return;
      }

      inFlight.set(taskId, { value, version });
      void (async () => {
        try {
          await options.publish(taskId, value);
          const currentFlight = inFlight.get(taskId);
          if (currentFlight?.version !== version || currentFlight.value !== value) return;
          inFlight.delete(taskId);
          // Record every completed write, even if a newer local version was
          // scheduled while this one was in flight. Firestore now contains
          // this value and may need a corrective publication.
          lastPublished.set(taskId, value);
          ensureDesiredValueIsScheduled(taskId);
        } catch (error) {
          const currentFlight = inFlight.get(taskId);
          if (currentFlight?.version !== version || currentFlight.value !== value) return;
          inFlight.delete(taskId);
          options.onError?.(error);
          const valueIsStillCurrent = versions.get(taskId) === version
            && desiredValues.get(taskId) === value;
          if (valueIsStillCurrent && mayRetry) {
            const retryDelayMs = options.retryDelayMs === undefined
              ? options.delayMs
              : options.retryDelayMs;
            if (retryDelayMs !== null) {
              schedulePublish(taskId, value, version, retryDelayMs, false);
            }
            return;
          }
          if (!valueIsStillCurrent) {
            ensureDesiredValueIsScheduled(taskId);
          }
        }
      })();
    }, delayMs));
  }

  return {
    seed(taskId, value) {
      cancel(taskId);
      lastPublished.set(taskId, value);
      desiredValues.set(taskId, value);
    },
    schedule(taskId, value) {
      clearTimer(taskId);
      const version = nextVersion(taskId);
      desiredValues.set(taskId, value);
      if (lastPublished.get(taskId) === value && !inFlight.has(taskId)) return;
      schedulePublish(taskId, value, version, options.delayMs, true);
    },
    cancel,
    dispose() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      versions.clear();
      lastPublished.clear();
      desiredValues.clear();
      inFlight.clear();
    },
  };
}
