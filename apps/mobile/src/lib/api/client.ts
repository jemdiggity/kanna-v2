import type {
  AgentEvent,
  CompanionDocumentKind,
  CompanionEvent,
  FrameAgentEvent,
  PermissionDecision,
} from "@kanna/agent-protocol";
import type {
  CompanionAssetSnapshot,
  TerminalScrollbackChunk,
  TerminalScrollbackRequest,
  TerminalWindowMetadata
} from "@kanna/stream-client";
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
  TaskInputAttachment,
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
      /** Present when the desktop sent a *bounded* window of the terminal and
       * kept older scrollback back for `requestScrollback`. */
      window?: TerminalWindowMetadata | null;
    }
  | { type: "output"; taskId: string; dataB64: string }
  /** The desktop replayed from where this viewer's buffer stopped: nothing is
   * re-hydrated, and the missed bytes follow as ordinary output. */
  | { type: "resumed"; taskId: string; window: TerminalWindowMetadata }
  | {
      type: "scrollback";
      taskId: string;
      chunk: TerminalScrollbackChunk;
    }
  | { type: "exit"; taskId: string; code: number }
  | { type: "error"; taskId: string; code?: string; message: string };

export interface TaskTerminalSubscription {
  close(): void;
  /** Raw PTY bytes (base64) written to the task's terminal, e.g. scroll
   * sequences replayed from the mobile terminal view. Optional because some
   * transports are read-only. */
  sendInput?(
    dataB64: string,
    submissionBoundary?: boolean,
    controlInput?: boolean
  ): void;
  /** Resize both the observer's xterm grid and the owning PTY. The transport
   * keeps this scoped to the attached task session. */
  resize?(cols: number, rows: number): void;
  /** Pull one bounded chunk of scrollback older than the loaded buffer.
   * Optional: a transport whose desktop sent the whole terminal has none to
   * pull. */
  requestScrollback?(request: TerminalScrollbackRequest): void;
}

export interface TaskSummaryFrameEvent {
  type: "summary";
  taskId: string;
  snippet?: string;
  activity: string;
  runtimeState: string;
  revision: number;
}

export type TaskSummaryStreamEvent =
  | TaskSummaryFrameEvent
  | { type: "connection"; connected: boolean };

export interface TaskSummarySubscription {
  close(): void;
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
  observeDesktopTaskSummaries?(
    desktopId: string,
    listener: (event: TaskSummaryStreamEvent) => void
  ): TaskSummarySubscription;
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
  markTaskRead(
    taskId: string,
    expectedActivityRevision?: number
  ): Promise<TaskActivityResponse>;
  closeTask(taskId: string): Promise<void>;
  sendTaskInput(
    taskId: string,
    input: string,
    attachment?: TaskInputAttachment
  ): Promise<void>;
  /**
   * Whether the desktop that owns this task advertises the image-attachment
   * contract on its own `/v1/status`.
   *
   * Per task, not per connection, and asked of the desktop the input will
   * actually reach — the composer's question is "will this photo arrive?",
   * which only the receiving desktop can answer. Reading it from the
   * connection's status is wrong on the relay path, where the status describes
   * the cloud rather than any desktop, and wrong in general once the phone can
   * see tasks owned by several machines at different versions.
   */
  supportsTaskInputAttachments(taskId: string): Promise<boolean>;
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
  observeDesktopTaskSummaries?(
    desktopId: string,
    listener: (event: TaskSummaryStreamEvent) => void
  ): TaskSummarySubscription;
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
  markTaskRead(
    taskId: string,
    expectedActivityRevision?: number
  ): Promise<TaskActivityResponse>;
  closeTask(taskId: string): Promise<void>;
  sendTaskInput(
    taskId: string,
    input: string,
    attachment?: TaskInputAttachment
  ): Promise<void>;
  /**
   * Whether the desktop that owns this task advertises the image-attachment
   * contract on its own `/v1/status`.
   *
   * Per task, not per connection, and asked of the desktop the input will
   * actually reach — the composer's question is "will this photo arrive?",
   * which only the receiving desktop can answer. Reading it from the
   * connection's status is wrong on the relay path, where the status describes
   * the cloud rather than any desktop, and wrong in general once the phone can
   * see tasks owned by several machines at different versions.
   */
  supportsTaskInputAttachments(taskId: string): Promise<boolean>;
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

export class RepoNotRegisteredError extends TaskCreationError {
  readonly code = "repo_not_registered" as const;
  readonly repoName: string;
  readonly desktopName: string;

  constructor(repoName: string, desktopName: string) {
    super(
      "not-created",
      `${repoName} is not registered on ${desktopName}. Register it on that machine before creating a task.`
    );
    this.name = "RepoNotRegisteredError";
    this.repoName = repoName;
    this.desktopName = desktopName;
  }
}

export function createKannaClient(transport: KannaTransport): KannaClient {
  return {
    ...(transport.observeDesktopTaskSummaries
      ? {
          observeDesktopTaskSummaries: (desktopId: string, listener: (event: TaskSummaryStreamEvent) => void) =>
            transport.observeDesktopTaskSummaries?.(desktopId, listener) ?? { close() {} }
        }
      : {}),
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
    markTaskRead: (taskId, expectedActivityRevision) =>
      transport.markTaskRead(taskId, expectedActivityRevision),
    closeTask: (taskId) => transport.closeTask(taskId),
    sendTaskInput: (taskId, input, attachment) =>
      attachment
        ? transport.sendTaskInput(taskId, input, attachment)
        : transport.sendTaskInput(taskId, input),
    supportsTaskInputAttachments: (taskId) =>
      transport.supportsTaskInputAttachments(taskId),
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
