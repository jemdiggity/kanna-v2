// Provider-neutral agent session protocol types.
//
// The Rust crate `crates/kanna-agent-protocol` is the schema source of
// truth; everything under ./generated is produced from it by
// `scripts/generate-agent-protocol-types.sh`. Do not edit generated files —
// regenerate them instead. CI fails on drift via
// `scripts/check-agent-protocol-types.sh`.

export type { AgentEvent } from "./generated/AgentEvent";
export type { AddRepoRequest } from "./generated/AddRepoRequest";
export type { BlockTaskRequest } from "./generated/BlockTaskRequest";
export type { ClientFrame } from "./generated/ClientFrame";
export type { CompleteStageRequest } from "./generated/CompleteStageRequest";
export type { CreateTaskRequest } from "./generated/CreateTaskRequest";
export type { CreateTaskResponse } from "./generated/CreateTaskResponse";
export type { DesktopDescriptor } from "./generated/DesktopDescriptor";
export type { FrameAgentEvent } from "./generated/FrameAgentEvent";
export type { MobileServerStatus } from "./generated/MobileServerStatus";
export type { PermissionDecision } from "./generated/PermissionDecision";
export type { RepoDetail } from "./generated/RepoDetail";
export type { RepoSummary } from "./generated/RepoSummary";
export type { RequestRevisionRequest } from "./generated/RequestRevisionRequest";
export type { ServerFrame } from "./generated/ServerFrame";
export type { SessionEndReason } from "./generated/SessionEndReason";
export type { SetTaskParentRequest } from "./generated/SetTaskParentRequest";
export type { StreamKind } from "./generated/StreamKind";
export type { TaskActionResponse } from "./generated/TaskActionResponse";
export type { TaskDetail } from "./generated/TaskDetail";
export type { TaskSummary } from "./generated/TaskSummary";
export type { TurnStats } from "./generated/TurnStats";
export type { TurnStatus } from "./generated/TurnStatus";
