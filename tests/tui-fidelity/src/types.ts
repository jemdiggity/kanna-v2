export interface TermSnapshotFrame {
  type: "term_snapshot";
  task_id: string;
  cols: number;
  rows: number;
  data_b64: string;
}

export interface TermOutputFrame {
  type: "term_output";
  task_id: string;
  data_b64: string;
}

export type TerminalFrame = TermSnapshotFrame | TermOutputFrame;

export interface EmitterOutput {
  fixture: string;
  cols: number;
  rows: number;
  snapshot_at: number;
  resnapshot_at: number | null;
  used_visible_text_fallback: boolean;
  frames: TerminalFrame[];
}

export interface FixtureDefinition {
  name: string;
  description: string;
  bytes: Uint8Array;
  snapshotAt: number;
  resnapshotAt?: number;
  chunkPattern?: number[];
  cols?: number;
  rows?: number;
  allowFallback?: boolean;
  replayThroughSessionStore?: boolean;
  assertStreamCompaction?: boolean;
}

export interface SessionStoreMutationMetrics {
  appendCount: number;
  maxRetainedStart: number;
  replaceCount: number;
  snapshotCount: number;
}

export interface SessionStoreRenderResult {
  grid: GridSnapshot;
  metrics: SessionStoreMutationMetrics;
}

export interface CellSnapshot {
  row: number;
  col: number;
  chars: string;
  width: number;
  fg: number;
  bg: number;
  flags: number;
}

export interface GridSnapshot {
  cols: number;
  rows: number;
  serialized: string;
  cells: CellSnapshot[];
}

export interface CellDiff {
  row: number;
  col: number;
  expected: CellSnapshot;
  actual: CellSnapshot;
}

export interface FixtureResult {
  name: string;
  description: string;
  snapshotAt: number;
  usedVisibleTextFallback: boolean;
  divergentCells: number;
  firstDiffs: CellDiff[];
  pathSerialized: string;
  referenceSerialized: string;
}
