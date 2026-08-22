export interface LoiterRangeLoader {
  observe(startLine: number): void;
  dispose(): void;
}

export function createLoiterRangeLoader(
  load: (startLine: number) => void,
  delayMs = 300
): LoiterRangeLoader {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const loaded = new Set<number>();
  return {
    observe(startLine) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (loaded.has(startLine)) return;
        loaded.add(startLine);
        load(startLine);
      }, delayMs);
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
    }
  };
}
