use crate::events::{AgentEvent, PermissionDecision};

/// What a provider adapter can do. Surfaces hide UI for unsupported features
/// (e.g. no Allow/Deny prompts for providers without permission requests).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Capabilities {
    /// The provider surfaces interactive permission requests.
    pub permission_requests: bool,
    /// The provider accepts user messages while a turn is running.
    pub mid_run_input: bool,
}

/// How the provider process maps to turns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnModel {
    /// One long-lived process serves many turns; input goes over stdin.
    Persistent,
    /// One process per turn; each user message is a resume-respawn.
    PerTurn,
}

/// A command the daemon should spawn (headless, plain pipes, no PTY).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnSpec {
    /// Executable name; the daemon resolves it to an absolute path.
    pub executable: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    /// A line to write to the child's stdin right after spawning, when the
    /// provider takes its prompt over stdin (Claude's stream-json input mode
    /// ignores the `-p` prompt argument). `None` means the daemon should
    /// close stdin immediately instead (Codex blocks on piped stdin until
    /// EOF).
    pub initial_stdin: Option<String>,
}

/// Provider-independent inputs for building a spawn command.
#[derive(Debug, Clone, Default)]
pub struct SpawnCtx {
    /// The task prompt (initial spawn) — resume spawns take the message
    /// separately.
    pub prompt: String,
    /// Task worktree/project directory. The daemon also sets this as the child
    /// process cwd, but some providers need an explicit project-dir flag.
    pub cwd: String,
    pub model: Option<String>,
    /// Kanna permission mode (`dontAsk` / `acceptEdits` / `default`); each
    /// adapter maps it onto its provider's flags or config.
    pub permission_mode: Option<String>,
    pub allowed_tools: Vec<String>,
    pub disallowed_tools: Vec<String>,
    pub max_turns: Option<u32>,
    pub max_budget_usd: Option<f64>,
    pub system_prompt: Option<String>,
    pub mcp_config_path: Option<String>,
}

/// How to deliver an interrupt to the provider.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InterruptAction {
    /// Write this line to the provider's stdin.
    StdinLine(String),
    /// Send SIGINT to the provider process.
    Signal,
}

/// Translates one provider's CLI surface to the neutral protocol.
///
/// Implementations are stateful per session: they capture the provider
/// session id while parsing and may number outgoing protocol requests.
/// `parse_line` is infallible — anything unrecognized becomes
/// [`AgentEvent::Raw`], never an error and never silence.
pub trait ProviderAdapter: Send {
    /// Stable provider name (matches `pipeline_item.agent_provider`).
    fn provider(&self) -> &'static str;

    fn capabilities(&self) -> Capabilities;

    fn turn_model(&self) -> TurnModel;

    /// Build the spawn command for a new session.
    fn initial_spawn(&self, ctx: &SpawnCtx) -> SpawnSpec;

    /// Build the spawn command that resumes `session_id` with a new user
    /// message (used after crashes for persistent providers; used for every
    /// turn by [`TurnModel::PerTurn`] providers).
    fn resume_spawn(&self, ctx: &SpawnCtx, session_id: &str, message: &str) -> SpawnSpec;

    /// Translate one stdout line into zero or more neutral events.
    fn parse_line(&mut self, line: &str) -> Vec<AgentEvent>;

    /// The provider's own session id, once observed in the stream.
    fn provider_session_id(&self) -> Option<String>;

    /// Encode a user message as a stdin line. `None` when the provider does
    /// not take stdin input ([`TurnModel::PerTurn`] — use `resume_spawn`).
    fn encode_input(&mut self, text: &str) -> Option<String>;

    fn encode_interrupt(&mut self) -> InterruptAction;

    /// Encode a request to switch the model mid-session as a stdin line.
    /// `None` when the provider can't change model in-band; the daemon then
    /// applies the new model on the next spawn instead.
    fn encode_set_model(&mut self, _model: &str) -> Option<String> {
        None
    }

    /// Encode the answer to a pending permission request as a stdin line.
    /// `None` when the provider has no permission protocol.
    fn encode_permission_response(
        &mut self,
        request_id: &str,
        decision: &PermissionDecision,
    ) -> Option<String>;
}

/// Join the Kanna preamble and the task prompt into one message for providers
/// without a native system-prompt channel. Stage composition owns sectioning,
/// so an already-sectioned prompt is preserved; raw prompts receive a
/// compatibility `## Your Task` heading. The TS mirror is
/// `buildKannaRuntimeUserPrompt` in `packages/core/src/pipeline/prompt-builder.ts`
/// — keep the formats in sync.
pub fn prompt_with_system_prompt(system_prompt: Option<&str>, prompt: &str) -> String {
    match system_prompt.filter(|value| !value.trim().is_empty()) {
        Some(system_prompt) if prompt.trim().is_empty() => system_prompt.to_string(),
        Some(system_prompt) if has_outer_prompt_section(prompt) => {
            format!("{system_prompt}\n\n{prompt}")
        }
        Some(system_prompt) => format!("{system_prompt}\n\n## Your Task\n\n{prompt}"),
        None => prompt.to_string(),
    }
}

fn has_outer_prompt_section(prompt: &str) -> bool {
    matches!(
        prompt.lines().map(str::trim).find(|line| !line.is_empty()),
        Some("## Agent Instructions") | Some("## Your Task")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_adapter_is_object_safe() {
        fn _takes_boxed(_: Box<dyn ProviderAdapter + Send>) {}
    }

    #[test]
    fn prompt_with_system_prompt_delimits_the_task_with_a_heading() {
        assert_eq!(
            prompt_with_system_prompt(Some("Kanna task context"), "ship it"),
            "Kanna task context\n\n## Your Task\n\nship it"
        );
    }

    #[test]
    fn prompt_with_system_prompt_does_not_duplicate_an_existing_task_section() {
        let prompt = "## Agent Instructions\n\nFollow policy.\n\n## Your Task\n\nShip it";
        let result = prompt_with_system_prompt(Some("Kanna task context"), prompt);
        assert_eq!(result, format!("Kanna task context\n\n{prompt}"));
        assert_eq!(
            result
                .lines()
                .filter(|line| *line == "## Your Task")
                .count(),
            1
        );
    }

    #[test]
    fn prompt_with_system_prompt_preserves_an_agent_only_section() {
        let prompt = "## Agent Instructions\n\nFollow policy.";
        let result = prompt_with_system_prompt(Some("Kanna task context"), prompt);

        assert_eq!(result, format!("Kanna task context\n\n{prompt}"));
        assert!(!result.lines().any(|line| line == "## Your Task"));
    }

    #[test]
    fn prompt_with_system_prompt_does_not_add_a_section_for_a_blank_prompt() {
        assert_eq!(
            prompt_with_system_prompt(Some("Kanna task context"), " \n\t"),
            "Kanna task context"
        );
    }

    #[test]
    fn prompt_with_system_prompt_frames_a_raw_prompt_with_a_nested_task_heading() {
        let prompt = "Explain this excerpt:\n\n## Your Task\n\nNested text";
        let result = prompt_with_system_prompt(Some("Kanna task context"), prompt);

        assert_eq!(
            result,
            format!("Kanna task context\n\n## Your Task\n\n{prompt}")
        );
        assert_eq!(
            result
                .lines()
                .filter(|line| *line == "## Your Task")
                .count(),
            2
        );
    }

    #[test]
    fn prompt_with_system_prompt_passes_the_prompt_through_without_a_preamble() {
        assert_eq!(prompt_with_system_prompt(None, "ship it"), "ship it");
        assert_eq!(prompt_with_system_prompt(Some("  "), "ship it"), "ship it");
    }
}
