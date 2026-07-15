import type {
  AgentEvent,
  FrameAgentEvent,
  PermissionDecision,
} from "@kanna/agent-protocol";
import type {
  CreateTaskRequest,
  CreateTaskResponse,
  RepoSummary,
  DesktopSummary,
  MobileServerStatus,
  PairingSession,
  TaskActionResponse,
  TaskActivityResponse,
  TaskFileContent,
  TaskSummary
} from "./types";

export type TaskTerminalStreamEvent =
  | { type: "ready"; taskId: string; cols?: number; rows?: number }
  | { type: "output"; taskId: string; dataB64: string }
  | { type: "exit"; taskId: string; code: number }
  | { type: "error"; taskId: string; message: string };

export interface TaskTerminalSubscription {
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

export interface KannaTransport {
  getTaskRouteIdentity?(taskId: string): string;
  getStatus(): Promise<MobileServerStatus>;
  listDesktops(): Promise<DesktopSummary[]>;
  listRepos(): Promise<RepoSummary[]>;
  listRepoTasks(repoId: string): Promise<TaskSummary[]>;
  listRecentTasks(): Promise<TaskSummary[]>;
  searchTasks(query: string): Promise<TaskSummary[]>;
  createTask(input: CreateTaskRequest): Promise<CreateTaskResponse>;
  runMergeAgent(taskId: string): Promise<TaskActionResponse>;
  advanceTaskStage(taskId: string): Promise<TaskActionResponse>;
  markTaskRead(taskId: string): Promise<TaskActivityResponse>;
  closeTask(taskId: string): Promise<void>;
  sendTaskInput(taskId: string, input: string): Promise<void>;
  readTaskFile(taskId: string, path: string): Promise<TaskFileContent>;
  observeTaskTerminal(
    taskId: string,
    listener: (event: TaskTerminalStreamEvent) => void
  ): TaskTerminalSubscription;
  observeTaskAgent(
    taskId: string,
    listener: (event: TaskAgentStreamEvent) => void
  ): TaskAgentSubscription;
  createPairingSession(): Promise<PairingSession>;
}

export interface KannaClient {
  getTaskRouteIdentity?(taskId: string): string;
  getStatus(): Promise<MobileServerStatus>;
  listDesktops(): Promise<DesktopSummary[]>;
  listRepos(): Promise<RepoSummary[]>;
  listRepoTasks(repoId: string): Promise<TaskSummary[]>;
  listRecentTasks(): Promise<TaskSummary[]>;
  searchTasks(query: string): Promise<TaskSummary[]>;
  createTask(input: CreateTaskRequest): Promise<CreateTaskResponse>;
  runMergeAgent(taskId: string): Promise<TaskActionResponse>;
  advanceTaskStage(taskId: string): Promise<TaskActionResponse>;
  markTaskRead(taskId: string): Promise<TaskActivityResponse>;
  closeTask(taskId: string): Promise<void>;
  sendTaskInput(taskId: string, input: string): Promise<void>;
  readTaskFile(taskId: string, path: string): Promise<TaskFileContent>;
  observeTaskTerminal(
    taskId: string,
    listener: (event: TaskTerminalStreamEvent) => void
  ): TaskTerminalSubscription;
  observeTaskAgent(
    taskId: string,
    listener: (event: TaskAgentStreamEvent) => void
  ): TaskAgentSubscription;
  createPairingSession(): Promise<PairingSession>;
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
    listRecentTasks: () => transport.listRecentTasks(),
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
    runMergeAgent: (taskId) => transport.runMergeAgent(taskId),
    advanceTaskStage: (taskId) => transport.advanceTaskStage(taskId),
    markTaskRead: (taskId) => transport.markTaskRead(taskId),
    closeTask: (taskId) => transport.closeTask(taskId),
    sendTaskInput: (taskId, input) => transport.sendTaskInput(taskId, input),
    readTaskFile: (taskId, path) => transport.readTaskFile(taskId, path),
    observeTaskTerminal: (taskId, listener) =>
      transport.observeTaskTerminal(taskId, listener),
    observeTaskAgent: (taskId, listener) =>
      transport.observeTaskAgent(taskId, listener),
    createPairingSession: () => transport.createPairingSession()
  };
}
