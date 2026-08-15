import type {
  AgentEvent,
  CompanionDocumentKind,
  CompanionEvent,
  FrameAgentEvent,
  PermissionDecision,
} from "@kanna/agent-protocol";
import type { CompanionAssetSnapshot } from "@kanna/stream-client";
import type {
  AbortTaskCreationRequest,
  CreateTaskRequest,
  CreateTaskResponse,
  RepoSummary,
  RepoCommandCatalog,
  RunRepoCommandResponse,
  DesktopSummary,
  MobileServerStatus,
  TaskActionResponse,
  TaskActivityResponse,
  TaskDiffContent,
  TaskDiffRequest,
  TaskFileContent,
  TaskFileMentionInput,
  TaskFileMentionResolution,
  TaskDetail,
  TaskSummary
} from "./types";

export type TaskTerminalStreamEvent =
  | {
      type: "snapshot";
      taskId: string;
      cols: number;
      rows: number;
      dataB64: string;
    }
  | { type: "output"; taskId: string; dataB64: string }
  | { type: "exit"; taskId: string; code: number }
  | { type: "error"; taskId: string; message: string };

export interface TaskTerminalSubscription {
  close(): void;
  /** Raw PTY bytes (base64) written to the task's terminal, e.g. scroll
   * sequences replayed from the mobile terminal view. Optional because some
   * transports are read-only. */
  sendInput?(dataB64: string): void;
  /** Resize both the observer's xterm grid and the owning PTY. The transport
   * keeps this scoped to the attached task session. */
  resize?(cols: number, rows: number): void;
}

export type TaskAgentStreamEvent =
  | { type: "snapshot"; taskId: string; events: FrameAgentEvent[]; nextSeq: number }
  | { type: "event"; taskId: string; seq: number; event: AgentEvent }
  | { type: "status"; taskId: string; status: string }
  | { type: "exit"; taskId: string; code: number }
  | { type: "error"; taskId: string; message: string };

export interface TaskAgentSubscription {
  close(): void;
  sendInput(input: string): void;
  sendPermission(requestId: string, decision: PermissionDecision): void;
  interrupt(): void;
}

export type TaskCompanionStreamEvent =
  | { type: "connection"; taskId: string; connected: boolean }
  | {
      type: "snapshot";
      taskId: string;
      sessionId: string;
      revision: string;
      documentKind: CompanionDocumentKind;
      html: string;
      sourceOrigin?: string;
      assets: CompanionAssetSnapshot[];
    }
  | { type: "unavailable"; taskId: string }
  | {
      type: "event_result";
      taskId: string;
      sessionId: string;
      revision: string;
      eventId: string;
      accepted: boolean;
      code?: string;
      message?: string;
    }
  | { type: "error"; taskId: string; code: string; message: string };

export interface TaskCompanionSubscription {
  close(): void;
  sendEvent(sessionId: string, revision: string, event: CompanionEvent): boolean;
}

export interface KannaTransport {
  getTaskRouteIdentity?(taskId: string): string;
  getStatus(): Promise<MobileServerStatus>;
  listDesktops(): Promise<DesktopSummary[]>;
  listRepos(): Promise<RepoSummary[]>;
  listRepoTasks(repoId: string): Promise<TaskSummary[]>;
  listRepoCommands(repoId: string): Promise<RepoCommandCatalog>;
  runRepoCommand(
    repoId: string,
    commandId: string,
    catalogRevision: string
  ): Promise<RunRepoCommandResponse>;
  listRecentTasks(): Promise<TaskSummary[]>;
  getTask?(taskId: string): Promise<TaskDetail>;
  searchTasks(query: string): Promise<TaskSummary[]>;
  createTask(input: CreateTaskRequest): Promise<CreateTaskResponse>;
  abortTaskCreation(input: AbortTaskCreationRequest): Promise<void>;
  runMergeAgent(taskId: string): Promise<TaskActionResponse>;
  advanceTaskStage(taskId: string): Promise<TaskActionResponse>;
  markTaskRead(taskId: string): Promise<TaskActivityResponse>;
  pinTask(taskId: string): Promise<void>;
  unpinTask(taskId: string): Promise<void>;
  closeTask(taskId: string): Promise<void>;
  sendTaskInput(taskId: string, input: string): Promise<void>;
  readTaskFile(taskId: string, path: string): Promise<TaskFileContent>;
  resolveTaskFileMentions(
    taskId: string,
    mentions: readonly TaskFileMentionInput[]
  ): Promise<TaskFileMentionResolution>;
  readTaskDiff(taskId: string, request?: TaskDiffRequest): Promise<TaskDiffContent>;
  observeTaskTerminal(
    taskId: string,
    listener: (event: TaskTerminalStreamEvent) => void
  ): TaskTerminalSubscription;
  observeTaskAgent(
    taskId: string,
    listener: (event: TaskAgentStreamEvent) => void
  ): TaskAgentSubscription;
  observeTaskCompanion(
    taskId: string,
    listener: (event: TaskCompanionStreamEvent) => void
  ): TaskCompanionSubscription;
}

export interface KannaClient {
  getTaskRouteIdentity?(taskId: string): string;
  getStatus(): Promise<MobileServerStatus>;
  listDesktops(): Promise<DesktopSummary[]>;
  listRepos(): Promise<RepoSummary[]>;
  listRepoTasks(repoId: string): Promise<TaskSummary[]>;
  listRepoCommands(repoId: string): Promise<RepoCommandCatalog>;
  runRepoCommand(
    repoId: string,
    commandId: string,
    catalogRevision: string
  ): Promise<RunRepoCommandResponse>;
  listRecentTasks(): Promise<TaskSummary[]>;
  getTask?(taskId: string): Promise<TaskDetail>;
  searchTasks(query: string): Promise<TaskSummary[]>;
  createTask(input: CreateTaskRequest): Promise<CreateTaskResponse>;
  abortTaskCreation(input: AbortTaskCreationRequest): Promise<void>;
  runMergeAgent(taskId: string): Promise<TaskActionResponse>;
  advanceTaskStage(taskId: string): Promise<TaskActionResponse>;
  markTaskRead(taskId: string): Promise<TaskActivityResponse>;
  pinTask(taskId: string): Promise<void>;
  unpinTask(taskId: string): Promise<void>;
  closeTask(taskId: string): Promise<void>;
  sendTaskInput(taskId: string, input: string): Promise<void>;
  readTaskFile(taskId: string, path: string): Promise<TaskFileContent>;
  resolveTaskFileMentions(
    taskId: string,
    mentions: readonly TaskFileMentionInput[]
  ): Promise<TaskFileMentionResolution>;
  readTaskDiff(taskId: string, request?: TaskDiffRequest): Promise<TaskDiffContent>;
  observeTaskTerminal(
    taskId: string,
    listener: (event: TaskTerminalStreamEvent) => void
  ): TaskTerminalSubscription;
  observeTaskAgent(
    taskId: string,
    listener: (event: TaskAgentStreamEvent) => void
  ): TaskAgentSubscription;
  observeTaskCompanion(
    taskId: string,
    listener: (event: TaskCompanionStreamEvent) => void
  ): TaskCompanionSubscription;
}

export type TaskCreationOutcome = "not-created" | "unknown";

export class TaskCreationError extends Error {
  readonly outcome: TaskCreationOutcome;
  readonly cause: unknown;

  constructor(
    outcome: TaskCreationOutcome,
    message: string,
    cause?: unknown
  ) {
    super(message);
    this.name = "TaskCreationError";
    this.outcome = outcome;
    this.cause = cause;
  }
}

export function createKannaClient(transport: KannaTransport): KannaClient {
  return {
    ...(transport.getTaskRouteIdentity
      ? {
          getTaskRouteIdentity: (taskId: string) =>
            transport.getTaskRouteIdentity!(taskId)
        }
      : {}),
    getStatus: () => transport.getStatus(),
    listDesktops: () => transport.listDesktops(),
    listRepos: () => transport.listRepos(),
    listRepoTasks: (repoId) => transport.listRepoTasks(repoId),
    listRepoCommands: (repoId) => transport.listRepoCommands(repoId),
    runRepoCommand: (repoId, commandId, catalogRevision) =>
      transport.runRepoCommand(repoId, commandId, catalogRevision),
    listRecentTasks: () => transport.listRecentTasks(),
    ...(transport.getTask
      ? { getTask: (taskId: string) => transport.getTask!(taskId) }
      : {}),
    searchTasks: (query) => transport.searchTasks(query),
    createTask: async (input) => {
      try {
        return await transport.createTask(input);
      } catch (error) {
        if (error instanceof TaskCreationError) {
          throw error;
        }
        throw new TaskCreationError(
          "unknown",
          error instanceof Error ? error.message : String(error),
          error
        );
      }
    },
    abortTaskCreation: (input) => transport.abortTaskCreation(input),
    runMergeAgent: (taskId) => transport.runMergeAgent(taskId),
    advanceTaskStage: (taskId) => transport.advanceTaskStage(taskId),
    markTaskRead: (taskId) => transport.markTaskRead(taskId),
    pinTask: (taskId) => transport.pinTask(taskId),
    unpinTask: (taskId) => transport.unpinTask(taskId),
    closeTask: (taskId) => transport.closeTask(taskId),
    sendTaskInput: (taskId, input) => transport.sendTaskInput(taskId, input),
    readTaskFile: (taskId, path) => transport.readTaskFile(taskId, path),
    resolveTaskFileMentions: (taskId, mentions) =>
      transport.resolveTaskFileMentions(taskId, mentions),
    readTaskDiff: (taskId, request) => transport.readTaskDiff(taskId, request),
    observeTaskTerminal: (taskId, listener) =>
      transport.observeTaskTerminal(taskId, listener),
    observeTaskAgent: (taskId, listener) =>
      transport.observeTaskAgent(taskId, listener),
    observeTaskCompanion: (taskId, listener) =>
      transport.observeTaskCompanion(taskId, listener)
  };
}
