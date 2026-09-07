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
  write: (sessionId: string, data: string, callback?: () => void) => void;
  input: (sessionId: string, data: string) => void;
  refresh: (sessionId: string) => void;
  findTextCell: (
    sessionId: string,
    text: string,
  ) => { column: number; row: number; columns: number; rows: number } | null;
  cellAttributes: (
    sessionId: string,
    row: number,
    column: number,
  ) => {
    bold: boolean;
    inverse: boolean;
    foreground: number;
    foregroundMode: number;
  } | null;
  selectText: (sessionId: string, text: string) => string | null;
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

interface KannaTerminalOutputPerfEvent {
  atMs: number;
  component: "webview";
  sessionId: string;
  stage: string;
  event: "stall" | "recovered" | "gap";
  durationMs: number;
  bytes: number;
  pendingChunks: number;
  pendingBytes: number;
}

interface KannaTerminalOutputPerfSnapshot {
  activeSessions: number;
  maxFrameGapMs: number;
  maxEventLoopDriftMs: number;
  maxXtermBacklogMs: number;
  pendingChunks: number;
  pendingBytes: number;
  latestEvent: KannaTerminalOutputPerfEvent | null;
}

interface KannaTerminalOutputPerfE2EApi {
  snapshot: () => KannaTerminalOutputPerfSnapshot;
  clear: () => void;
  beginEventLoopProbe: (visibility: "visible" | "hidden") => void;
  endEventLoopProbe: () => void;
}

interface KannaAuthIndexedDbFaultE2EApi {
  installed: boolean;
  openFailures: number;
}

interface KannaServerWorkE2EApi {
  start: (durationMs: number) => Promise<void>;
  wait: () => Promise<void>;
  isActive: () => boolean;
}

interface KannaTerminalStreamsE2EApi {
  detach: (taskId: string) => Promise<void>;
}

type KannaRemoteCompanionE2EApi = import("./e2eRemoteCompanion")
  .E2ERemoteCompanionApi;

interface KannaE2EHook {
  ready: boolean;
  /** Set once App.vue has decided whether to show the startup shortcuts modal. */
  startupOverlaysSettled: boolean;
  setupState: object | null;
  dbName: string;
  taskSwitchPerf: KannaTaskSwitchPerfE2EApi;
  appMetrics: KannaAppMetricsE2EApi;
  terminalOutputPerf: KannaTerminalOutputPerfE2EApi;
  resetStreamClient?: () => void;
  failNextInvoke?: string;
  /** Optional install URL used by the mock desktop E2E to exercise the configured state. */
  mobileInstallUrl?: string;
  serverWork?: KannaServerWorkE2EApi;
  terminalStreams?: KannaTerminalStreamsE2EApi;
  invokes?: {
    clear(): void;
    getAll(): Array<{ cmd: string; args?: unknown }>;
    failNext(cmd: string, message: string): void;
    succeedNext(cmd: string, value: unknown): void;
  };
  events?: {
    clear(): void;
    getAll(): Array<{ event: string; payload?: unknown }>;
  };
  terminalBuffers?: KannaTerminalBuffersE2EApi;
  remoteCompanion?: KannaRemoteCompanionE2EApi;
}

interface Window {
  __KANNA_E2E__?: KannaE2EHook;
  __KANNA_E2E_AUTH_INDEXEDDB_FAULT__?: KannaAuthIndexedDbFaultE2EApi;
}
