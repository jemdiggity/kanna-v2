//! Provider-neutral agent session protocol.
//!
//! Defines the neutral [`AgentEvent`] schema that the daemon journals per
//! agent session and every surface (desktop, kanna-server, relay, mobile)
//! consumes, plus the [`ProviderAdapter`] trait that translates each agent
//! CLI's headless output into that schema.
//!
//! Spec: `docs/superpowers/specs/2026-06-12-themed-agent-view-design.md`.
//!
//! TypeScript mirrors of these types are generated with `ts-rs` (feature
//! `typescript`) into `packages/agent-protocol`.

mod adapter;
pub mod claude;
pub mod codex;
mod events;
pub mod frames;
pub mod mcp;
pub mod opencode;
mod providers;

pub use adapter::{
    prompt_with_system_prompt, Capabilities, InterruptAction, ProviderAdapter, SpawnCtx, SpawnSpec,
    TurnModel,
};
pub use claude::ClaudeAdapter;
pub use codex::CodexAdapter;
pub use events::{
    truncate_text, truncate_text_to, AgentEvent, PermissionDecision, SessionEndReason, TurnStats,
    TurnStatus, MAX_TEXT_BYTES,
};
pub use frames::{
    ClientFrame, CompanionAsset, CompanionDocumentKind, CompanionEvent, FrameAgentEvent,
    KspCapability, ServerFrame, StateChangeScope, StreamKind, TaskStateChange, TerminalViewerRole,
};
pub use opencode::OpencodeAdapter;
pub use providers::{
    agent_provider_specs, parse_provider_selector, AgentProvider, AgentProviderSpec,
    AgentSessionType, EffortOverride, ProviderSelector, PROVIDER_RESOLUTION_CASES_JSON,
};
