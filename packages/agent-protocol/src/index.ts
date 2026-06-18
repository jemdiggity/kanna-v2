// Provider-neutral agent session protocol types.
//
// The Rust crate `crates/kanna-agent-protocol` is the schema source of
// truth; everything under ./generated is produced from it by
// `scripts/generate-agent-protocol-types.sh`. Do not edit generated files —
// regenerate them instead. CI fails on drift via
// `scripts/check-agent-protocol-types.sh`.

export type { AgentEvent } from "./generated/AgentEvent";
export type { ClientFrame } from "./generated/ClientFrame";
export type { FrameAgentEvent } from "./generated/FrameAgentEvent";
export type { PermissionDecision } from "./generated/PermissionDecision";
export type { ServerFrame } from "./generated/ServerFrame";
export type { SessionEndReason } from "./generated/SessionEndReason";
export type { StreamKind } from "./generated/StreamKind";
export type { TurnStats } from "./generated/TurnStats";
export type { TurnStatus } from "./generated/TurnStatus";
export { formatCompactCount } from "./format";
