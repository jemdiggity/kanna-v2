declare const __KANNA_MOBILE__: boolean;

interface KannaTaskSwitchPerfE2EApi {
  getLatest: () => unknown;
  getAll: () => unknown[];
  clear: () => void;
}

interface KannaTerminalBufferStats {
  sessionId: string;
  lineCount: number;
  baseY: number;
  viewportY: number;
  matchingLineCount: number;
  firstMatchingLine: string | null;
  lastMatchingLine: string | null;
  hasEndMarker: boolean;
}

interface KannaTerminalBuffersE2EApi {
  stats: (sessionId: string, matcher?: RegExp, endMarker?: string) => KannaTerminalBufferStats;
  lines: (sessionId: string) => string[];
  sessionIds: () => string[];
}

interface KannaAppMetricsSnapshot {
  invokeCounts: Record<string, number>;
  listenCounts: Record<string, number>;
  unlistenCounts: Record<string, number>;
  activeListenCounts: Record<string, number>;
}

interface KannaAppMetricsE2EApi {
  snapshot: () => KannaAppMetricsSnapshot;
  clear: () => void;
}

interface KannaAuthIndexedDbFaultE2EApi {
  installed: boolean;
  openFailures: number;
}

interface KannaE2EHook {
  ready: boolean;
  setupState: object | null;
  dbName: string;
  taskSwitchPerf: KannaTaskSwitchPerfE2EApi;
  appMetrics: KannaAppMetricsE2EApi;
  resetStreamClient?: () => void;
  invokes?: {
    clear(): void;
    getAll(): Array<{ cmd: string; args?: unknown }>;
  };
  terminalBuffers?: KannaTerminalBuffersE2EApi;
}

interface Window {
  __KANNA_E2E__?: KannaE2EHook;
  __KANNA_E2E_AUTH_INDEXEDDB_FAULT__?: KannaAuthIndexedDbFaultE2EApi;
}
