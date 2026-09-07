import type { CompanionEvent } from "@kanna/agent-protocol";
import type {
  CompanionEventResult,
  CompanionSnapshot,
} from "@kanna/stream-client";

export type DesktopRemoteTerminalEvent =
  | { type: "snapshot"; taskId: string; cols: number; rows: number; data: Uint8Array }
  | { type: "output"; taskId: string; data: Uint8Array }
  | { type: "exit"; taskId: string; code: number }
  | { type: "error"; taskId: string; message: string };

export interface DesktopRemoteTerminalSubscription {
  close(): void;
  registerViewer?(cols: number, rows: number): void;
  takeControl?(): void;
  releaseControl?(): void;
}

export interface ObserveDesktopRemoteTerminalOptions {
  desktopId: string;
  taskId: string;
  listener(event: DesktopRemoteTerminalEvent): void;
}

export type DesktopRemoteCompanionEvent =
  | { type: "snapshot"; taskId: string; snapshot: CompanionSnapshot }
  | { type: "unavailable"; taskId: string }
  | { type: "event_result"; taskId: string; result: CompanionEventResult }
  | { type: "connection"; taskId: string; connected: boolean }
  | { type: "error"; taskId: string; code: string; message: string };

export interface ObserveDesktopRemoteCompanionOptions {
  desktopId: string;
  taskId: string;
  listener(event: DesktopRemoteCompanionEvent): void;
}

export interface DesktopRemoteCompanionSubscription {
  close(): void;
  sendEvent(
    sessionId: string,
    revision: string,
    event: CompanionEvent,
  ): boolean;
}

export interface RemoteTaskActionOptions {
  desktopId: string;
  taskId: string;
}

export interface MarkRemoteTaskReadOptions extends RemoteTaskActionOptions {
  expectedActivityRevision: number;
}

export interface AdvanceRemoteTaskStageOptions extends RemoteTaskActionOptions {
  expectedTransitionRevision?: string;
}

export interface SendRemoteTerminalInputOptions extends RemoteTaskActionOptions {
  data: string;
  submissionBoundary?: boolean;
  controlInput?: boolean;
}

export interface ResizeRemoteTerminalOptions extends RemoteTaskActionOptions {
  cols: number;
  rows: number;
}

export interface ReadRemoteTaskFileOptions extends RemoteTaskActionOptions {
  path: string;
}

export interface RemoteTaskFileContent {
  path: string;
  content: string;
}

export interface RemoteTaskDirectoryEntry {
  name: string;
  path: string;
  isDir: boolean;
  size?: number | null;
}

export interface RemoteTaskDirectoryListing {
  path: string;
  entries: RemoteTaskDirectoryEntry[];
  offset: number;
  nextOffset: number | null;
  totalEntries: number;
}

export type RemoteTaskDiffRequest =
  | { scope: "branch"; mode: "none" | "staged" | "all" }
  | { scope: "working"; mode: "all" | "unstaged" | "staged" };

export interface RemoteTaskDiffContent {
  taskId: string;
  baseRef: string | null;
  mergeBase: string | null;
  patch: string;
  truncated: boolean;
}

export interface DesktopRemoteTerminalClient {
  close(): void;
  observeTerminal(
    options: ObserveDesktopRemoteTerminalOptions,
  ): DesktopRemoteTerminalSubscription;
  sendInput(options: SendRemoteTerminalInputOptions): Promise<void>;
  resize(options: ResizeRemoteTerminalOptions): Promise<void>;
  closeTask(options: RemoteTaskActionOptions): Promise<void>;
  advanceStage(options: AdvanceRemoteTaskStageOptions): Promise<void>;
  readTaskFile(options: ReadRemoteTaskFileOptions): Promise<RemoteTaskFileContent>;
  markTaskRead(options: MarkRemoteTaskReadOptions): Promise<void>;
}

export interface DesktopRemoteTaskClient extends DesktopRemoteTerminalClient {
  observeCompanion(
    options: ObserveDesktopRemoteCompanionOptions,
  ): DesktopRemoteCompanionSubscription;
}

export interface DesktopRemoteTaskViewClient extends DesktopRemoteTaskClient {
  listTaskDirectory(
    options: ReadRemoteTaskFileOptions & { showAllFiles?: boolean },
  ): Promise<RemoteTaskDirectoryListing>;
  readTaskDiff(
    options: RemoteTaskActionOptions & { request: RemoteTaskDiffRequest },
  ): Promise<RemoteTaskDiffContent>;
}
