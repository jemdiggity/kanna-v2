import type { CompanionEvent } from "@kanna/agent-protocol";
import type {
  CompanionEventResult,
  CompanionSnapshot,
} from "@kanna/stream-client";

export type DesktopRemoteTerminalEvent =
  | { type: "ready"; taskId: string }
  | { type: "output"; taskId: string; text: string }
  | { type: "exit"; taskId: string; code: number }
  | { type: "error"; taskId: string; message: string };

export interface DesktopRemoteTerminalSubscription {
  close(): void;
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
