# Structured Copilot Agent via GitHub Copilot SDK

## Decision

Do not implement the adapter in this branch.

The GitHub Copilot SDK is the right integration surface for structured Copilot
tasks, but the currently published Rust SDK cannot be added cleanly to Kanna's
workspace today:

- Latest crate: `github-copilot-sdk = 1.0.2`, published 2026-06-18.
- All non-placeholder published versions, including `1.0.0`, require
  `rust-version = "1.94.0"`.
- Kanna is pinned to Rust `1.93.1` in `rust-toolchain.toml`.
- The SDK's default feature, `bundled-cli`, downloads and embeds the Copilot CLI
  in `build.rs`.
- Even with `default-features = false`, `build.rs` downloads and extracts the
  CLI unless `COPILOT_SKIP_CLI_DOWNLOAD` is set.

That build-script behavior conflicts with Kanna's release expectations unless
the build environment is explicitly configured to skip SDK CLI downloads or the
SDK provides a no-download feature. Kanna already accepts a runtime dependency
on the user's `copilot` CLI for PTY Copilot, so the target architecture should
continue to resolve an explicit CLI path at runtime rather than embedding or
downloading the CLI during Kanna builds.

## SDK API Facts

Sources:

- <https://github.com/github/copilot-sdk>
- <https://github.com/github/copilot-sdk/blob/main/rust/README.md>
- <https://docs.github.com/en/enterprise-cloud@latest/copilot/how-tos/copilot-sdk/getting-started>
- <https://docs.github.com/en/enterprise-cloud@latest/copilot/how-tos/copilot-sdk/features/streaming-events>
- Local crate source from `github-copilot-sdk-1.0.2`.

The Rust SDK shape is:

- `Client::start(ClientOptions)` starts or connects to `copilot --server`.
- `ClientOptions` supports `CliProgram::Path(PathBuf)`, `COPILOT_CLI_PATH`,
  `Transport::Stdio`, `Transport::Tcp`, and `Transport::External`.
- `Client::create_session(SessionConfig)` creates a new session.
- `Client::resume_session(ResumeSessionConfig)` resumes an existing session.
- `SessionConfig` supports `model`, `streaming`, `system_message`,
  `working_directory`, `available_tools`, `excluded_tools`, and per-session
  permission/user-input handlers.
- `Session::send(MessageOptions)` sends a turn. `send_and_wait` waits for idle.
- `Session::abort()` interrupts the current turn.
- `Session::set_model(...)` changes models.
- `Session::subscribe()` yields `SessionEvent { id, timestamp, parent_id,
  event_type, data }`.

Permission handling is callback-based:

- Install `SessionConfig::with_permission_handler(Arc<dyn PermissionHandler>)`.
- The handler receives `(SessionId, RequestId, PermissionRequestData)`.
- It returns `PermissionResult::Decision(...)` or `PermissionResult::NoResult`.
- `NoResult` lets another client answer. Kanna needs an internal pending-request
  bridge rather than a blocking UI callback.

## SDK Event Schema

The generated Rust event schema includes these relevant event types:

- `assistant.turn_start` with `turnId`.
- `assistant.intent` with `intent`.
- `assistant.reasoning` with complete `content`.
- `assistant.reasoning_delta` with `deltaContent`.
- `assistant.message_start` with `messageId`.
- `assistant.message_delta` with `deltaContent`.
- `assistant.message` with final `content`, optional `model`, optional
  `outputTokens`, optional `reasoningText`, optional `toolRequests`.
- `assistant.turn_end` with `turnId`.
- `assistant.usage` with optional `inputTokens`, `outputTokens`, `duration`,
  and `cost`.
- `tool.user_requested` with `toolCallId`, `toolName`, optional `arguments`.
- `tool.execution_start` with `toolCallId`, `toolName`, optional `arguments`.
- `tool.execution_partial_result` with `toolCallId`, `partialOutput`.
- `tool.execution_progress` with `toolCallId`, `progressMessage`.
- `tool.execution_complete` with `toolCallId`, `success`, optional `error`,
  optional `result.content`, optional `result.detailedContent`.
- `permission.requested` with `requestId`, `permissionRequest`, and optional
  `promptRequest`.
- `permission.completed` with `requestId`, `result`, optional `toolCallId`.
- `session.error` with provider/runtime error detail.
- `session.idle` when the agent is idle.

The SDK is forward-compatible at runtime because `SessionEvent.event_type` is a
string and `data` is JSON. Kanna should treat unknown events as `AgentEvent::Raw`
or `AgentEvent::Diagnostic`, preserving the raw JSON.

## AgentEvent Mapping

Recommended mapping:

| SDK event | Kanna `AgentEvent` |
| --- | --- |
| `assistant.turn_start` | `TurnStarted { model: current_model }` |
| `assistant.intent` | `ToolProgress { call_id: None, message: intent }` or `Diagnostic` |
| `assistant.reasoning_delta` | `Thinking { text: deltaContent, truncated }` |
| `assistant.reasoning` | `Thinking { text: content, truncated }` if deltas were not emitted |
| `assistant.message_delta` | `AssistantText { text: deltaContent, truncated }` |
| `assistant.message` | `AssistantText` only when no deltas were seen for that `messageId`; map `toolRequests` to `ToolCall` |
| `assistant.turn_end` | hold until `assistant.usage` or `session.idle`, then emit `TurnCompleted` |
| `assistant.usage` | populate pending `TurnStats` |
| `tool.execution_start` | `ToolCall { call_id: toolCallId, tool_name: toolName, input: arguments }` |
| `tool.execution_partial_result` | `ToolResult` or `ToolProgress`; prefer `ToolProgress` until complete |
| `tool.execution_progress` | `ToolProgress { call_id: Some(toolCallId), message: progressMessage }` |
| `tool.execution_complete` | `ToolResult { call_id, output, is_error: !success }` |
| `permission.requested` | `PermissionRequest { request_id, tool_name, input }` |
| `permission.completed` | `PermissionResolved { request_id, decision }` |
| `session.error` | `Diagnostic`, then `TurnCompleted { status: Error }` if turn active |
| `session.idle` | `TurnCompleted { status: Success, stats }` |
| SDK stream closed | `SessionEnded { reason, exit_code: None, message }` |
| unknown event | `Raw { line: compact JSON, truncated }` |

Mapping state needs per-session bookkeeping:

- seen assistant message IDs, so final `assistant.message` does not duplicate
  already-streamed deltas;
- current turn ID;
- latest usage for `TurnStats`;
- pending permission request IDs;
- tool call names for permission correlation;
- session ID returned by the SDK, persisted as Kanna's provider session ID.

## Integration Design

The current daemon architecture has one good invariant to preserve:

`provider source -> AgentEvent -> AgentJournal -> attached daemon clients -> KSP -> desktop/mobile`

The weak point is `ProviderAdapter`: it assumes every structured provider is a
plain child process whose stdout can be parsed line-by-line. Copilot SDK is not
that shape. It is an async event source plus async control methods.

Recommended change:

1. Introduce an `AgentSource` abstraction in the daemon runtime, separate from
   the existing line parser:

   ```rust
   trait AgentSource: Send {
       async fn start(&mut self, sink: AgentEventSink) -> Result<StartedAgent, AgentError>;
       async fn send_input(&mut self, text: String) -> Result<(), AgentError>;
       async fn respond_permission(
           &mut self,
           request_id: String,
           decision: PermissionDecision,
       ) -> Result<(), AgentError>;
       async fn interrupt(&mut self) -> Result<(), AgentError>;
       async fn set_model(&mut self, model: String) -> Result<(), AgentError>;
       async fn shutdown(&mut self) -> Result<(), AgentError>;
       fn provider_session_id(&self) -> Option<String>;
   }
   ```

2. Keep the existing stdout adapters behind a `PipeAgentSource` wrapper:
   `SpawnSpec + ProviderAdapter::parse_line` becomes just one implementation of
   `AgentSource`.

3. Move the existing private `process_event` / `journal_and_fan_out` path into
   an `AgentEventSink` that all sources use. This preserves one journal/KSP
   path.

4. Add `CopilotSdkAgentSource`:
   - resolve `copilot` using the existing server/task-creator executable path
     approach, then pass `ClientOptions { program: CliProgram::Path(path), ... }`;
   - set `working_directory`/`cwd` to the task worktree;
   - set `streaming = Some(true)`;
   - map `model`, `system_prompt`, `allowed_tools`, and `disallowed_tools` into
     `SessionConfig`;
   - use a permission handler that records the request and awaits a daemon
     response through a per-request channel, while also emitting
     `PermissionRequest` through `AgentEventSink`;
   - call `session.subscribe()` and map each SDK event to `AgentEvent`;
   - call `session.send(...)` for initial prompt and later user input;
   - call `session.abort()` and `session.set_model(...)` for Kanna controls.

5. Update task defaults only after the source works:
   - `make_adapter` or its replacement returns a Copilot SDK source.
   - `resolve_agent_type(None, AgentProvider::Copilot)` defaults to
     `AgentSessionType::Agent`.
   - explicit `agent_type = "pty"` continues to use the existing PTY Copilot
     command.

## Tests

Minimum test coverage before flipping the default:

- Unit tests for SDK-event JSON to `AgentEvent` mapping using fixture JSON copied
  from the generated 1.0.2 schema.
- A schema guard test that deserializes representative
  `github_copilot_sdk::types::SessionEvent` fixtures and verifies every mapped
  event type still has the expected field names.
- Daemon runtime tests proving both `PipeAgentSource` and
  `CopilotSdkAgentSource` feed the same `AgentEventSink`.
- Task creator tests updated so Copilot defaults to `agent`, while explicit
  `pty` remains honored.
- Live Copilot SDK smoke test should be ignored by default because it requires a
  Copilot-authenticated CLI and may consume quota. Gate it behind an env var such
  as `KANNA_LIVE_COPILOT_SDK=1`.

## Open Prerequisites

Before implementation:

1. Decide whether Kanna can move from Rust 1.93.1 to 1.94.0.
2. If not, isolate the SDK behind a separate sidecar compiled with Rust 1.94.0,
   or wait for an SDK release with a lower MSRV.
3. Ensure release builds never download Copilot CLI in `build.rs`. Prefer an SDK
   feature or upstream change that makes "no bundled CLI, no build download"
   declarative. Until then, any dependency trial must set
   `COPILOT_SKIP_CLI_DOWNLOAD=1`.
4. Keep runtime CLI resolution explicit. Kanna should depend on the user's
   installed/authenticated `copilot` CLI, matching current PTY behavior.
