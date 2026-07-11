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
  closeTask(taskId: string): Promise<void>;
  sendTaskInput(taskId: string, input: string): Promise<void>;
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
  closeTask(taskId: string): Promise<void>;
  sendTaskInput(taskId: string, input: string): Promise<void>;
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
    createTask: (input) => transport.createTask(input),
    runMergeAgent: (taskId) => transport.runMergeAgent(taskId),
    advanceTaskStage: (taskId) => transport.advanceTaskStage(taskId),
    closeTask: (taskId) => transport.closeTask(taskId),
    sendTaskInput: (taskId, input) => transport.sendTaskInput(taskId, input),
    observeTaskTerminal: (taskId, listener) =>
      transport.observeTaskTerminal(taskId, listener),
    observeTaskAgent: (taskId, listener) =>
      transport.observeTaskAgent(taskId, listener),
    createPairingSession: () => transport.createPairingSession()
  };
}
