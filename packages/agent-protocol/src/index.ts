// Provider-neutral agent session protocol types.
//
// The Rust crate `crates/kanna-agent-protocol` is the schema source of
// truth; everything under ./generated is produced from it by
// `scripts/generate-agent-protocol-types.sh`. Do not edit generated files —
// regenerate them instead. CI fails on drift via
// `scripts/check-agent-protocol-types.sh`.

export type { AgentEvent } from "./generated/AgentEvent";
export type { AgentProvider } from "./generated/AgentProvider";
export type { AgentProviderSpec } from "./generated/AgentProviderSpec";
export type { AgentSessionType } from "./generated/AgentSessionType";
export type { ClientFrame } from "./generated/ClientFrame";
export type { CompanionAsset } from "./generated/CompanionAsset";
export type { CompanionDocumentKind } from "./generated/CompanionDocumentKind";
export type { CompanionEvent } from "./generated/CompanionEvent";
export type { FrameAgentEvent } from "./generated/FrameAgentEvent";
export type { KspCapability } from "./generated/KspCapability";
export type { PermissionDecision } from "./generated/PermissionDecision";
export type { ServerFrame } from "./generated/ServerFrame";
export type { SessionEndReason } from "./generated/SessionEndReason";
export type { StateChangeScope } from "./generated/StateChangeScope";
export type { StreamKind } from "./generated/StreamKind";
export type { TermResumePosition } from "./generated/TermResumePosition";
export type { TurnStats } from "./generated/TurnStats";
export type { TurnStatus } from "./generated/TurnStatus";
export {
  AGENT_PROVIDERS,
  AGENT_PROVIDER_SPECS,
  getAgentProviderSpec,
  isAgentProvider,
} from "./generated/AgentProviderRegistry";
