mod api;
mod commands;
mod config;
mod models;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "kanna-cli")]
#[command(about = "Kanna CLI")]
pub(crate) struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
#[allow(clippy::large_enum_variant)]
pub(crate) enum Commands {
    /// Report the client and authoritative connected Kanna server identity
    Info {
        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Print the generated Kanna task manual for the current spawned task
    Guide {
        /// Optional manual topic: config, workflows, agents, tasks, or mobile
        topic: Option<String>,

        /// Print machine-readable JSON
        #[arg(long)]
        json: bool,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Signal that a workflow stage is complete
    StageComplete {
        /// The task ID
        #[arg(long)]
        task_id: String,

        /// Completion status: "success" or "failure"
        #[arg(long)]
        status: String,

        /// Human-readable summary of what happened
        #[arg(long)]
        summary: String,

        /// Optional JSON string with extra metadata
        #[arg(long)]
        metadata: Option<String>,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// List repos from the desktop-backed local API
    Repo {
        #[command(subcommand)]
        command: RepoCommands,
    },
    /// Create and inspect tasks through the desktop-backed local API
    Task {
        #[command(subcommand)]
        command: TaskCommands,
    },
    /// List and call catalog-backed Kanna tools through the desktop local API
    Tool {
        #[command(subcommand)]
        command: ToolCommands,
    },
    /// Discover Kanna machines reachable through the signed-in account
    Machine {
        #[command(subcommand)]
        command: MachineCommands,
    },
}

#[derive(Subcommand)]
pub(crate) enum RepoCommands {
    /// List repos known to the running desktop server
    List {
        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Register an existing local git repository with the running desktop server
    Add {
        /// Existing local git repository path
        #[arg(long)]
        path: String,

        /// Optional display name
        #[arg(long)]
        name: Option<String>,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Detect repository metadata drift and update the existing record by default
    ReconcileMetadata {
        /// Existing repository ID
        #[arg(long)]
        repo_id: String,

        /// Apply detected metadata to the existing record; set false for a drift check
        #[arg(long, default_value_t = true, action = clap::ArgAction::Set)]
        apply: bool,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Find or create singleton agent tasks for a repo
    Agent {
        #[command(subcommand)]
        command: RepoAgentCommands,
    },
}

#[derive(Subcommand)]
pub(crate) enum RepoAgentCommands {
    /// List resolved agent definitions available to task creation
    List {
        /// The target repo ID
        #[arg(long)]
        repo_id: String,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Send a message to a repo-scoped singleton agent
    Signal {
        /// The target repo ID
        #[arg(long)]
        repo_id: String,

        /// The singleton agent name
        #[arg(long)]
        agent: String,

        /// Message to send to the agent
        #[arg(long)]
        message: String,

        /// Agent provider override, applied only when this signal creates the
        /// agent's task
        #[arg(long)]
        agent_provider: Option<String>,

        /// Provider-native reasoning effort override, applied only when this
        /// signal creates the agent's task
        #[arg(long)]
        effort: Option<String>,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
}

#[derive(Subcommand)]
#[allow(clippy::large_enum_variant)]
pub(crate) enum TaskCommands {
    /// List recent tasks from the running desktop server
    List {
        /// Limit results to one repo ID instead of recent tasks across repos
        #[arg(long)]
        repo_id: Option<String>,

        /// List recent tasks across repositories
        #[arg(long)]
        all_repos: bool,

        /// Maximum number of recent rows (server clamps to 200)
        #[arg(long)]
        limit: Option<u32>,

        /// Aggregate recent tasks from every reachable account machine
        #[arg(long)]
        all_machines: bool,

        /// Include closed tasks in the result
        #[arg(long)]
        include_closed: bool,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Search tasks by query text
    Search {
        /// Query text to search for
        #[arg(long)]
        query: String,

        /// Limit matches to one repository ID
        #[arg(long)]
        repo_id: Option<String>,

        /// Search across repositories explicitly
        #[arg(long)]
        all_repos: bool,

        /// Aggregate matches from every reachable account machine
        #[arg(long)]
        all_machines: bool,

        /// Include closed tasks in the result
        #[arg(long)]
        include_closed: bool,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Show one recent task by exact ID
    Status {
        /// The task ID
        #[arg(long)]
        task_id: String,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Fetch one task by exact ID
    Get {
        /// The task ID
        #[arg(long)]
        task_id: String,

        /// Omit unattested provider composer suggestions from task detail
        #[arg(long, default_value_t = true, action = clap::ArgAction::Set)]
        agent_view: bool,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// List a task's direct children, including closed children and verdicts
    Children {
        /// The parent task ID
        #[arg(long)]
        task_id: String,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Check whether open tasks still depend on a task's branch
    DependentTasksExist {
        /// Task whose branch may still have dependent tasks
        #[arg(long)]
        task_id: String,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Wait for a task to finish or close
    Wait {
        /// The task ID
        #[arg(long)]
        task_id: String,

        /// Maximum seconds to wait, clamped to 240 so the wait returns inside
        /// the tools/call timeout MCP clients enforce; a wait that runs out
        /// reports waitOutcome 'timeout' and can simply be called again
        #[arg(long, default_value_t = kanna_tool_catalog::DEFAULT_WAIT_TIMEOUT_SECS)]
        timeout_secs: u64,

        /// Poll interval in seconds
        #[arg(long, default_value_t = kanna_tool_catalog::DEFAULT_WAIT_POLL_SECS)]
        poll_secs: u64,

        /// Condition to wait for: finished or closed
        #[arg(long, default_value = "finished")]
        until: String,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Print a task's delivered-input history: what was said to its agent
    /// session from outside that session, oldest first
    Inputs {
        /// The task ID
        #[arg(long)]
        task_id: String,

        /// Number of most-recent records to print
        #[arg(long)]
        tail: Option<usize>,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Print recent task logs
    Logs {
        /// The task ID
        #[arg(long)]
        task_id: String,

        /// Number of recent relevant log events
        #[arg(long)]
        tail: Option<usize>,

        /// Remove unattested provider composer suggestions from logs
        #[arg(long, default_value_t = true, action = clap::ArgAction::Set)]
        agent_view: bool,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Create a task in a repo known to the running desktop server
    Create {
        /// The target repo ID
        #[arg(long)]
        repo_id: String,

        /// The task prompt
        #[arg(long)]
        prompt: String,

        /// Optional short display title for the task
        #[arg(long)]
        display_name: Option<String>,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,

        /// Optional workflow name override
        #[arg(long)]
        workflow_name: Option<String>,

        /// Optional base ref override
        #[arg(long)]
        base_ref: Option<String>,

        /// Ref the task's diffs compare against, when it differs from the
        /// fork point (a PR review child forks from the PR head and diffs
        /// against the PR base)
        #[arg(long)]
        diff_base_ref: Option<String>,

        /// Agent definition name to run the task's first stage with,
        /// overriding the workflow stage's own agent binding
        #[arg(long)]
        agent: Option<String>,

        /// Optional agent provider override
        #[arg(long)]
        agent_provider: Option<String>,

        /// Task session type: "pty" for raw terminal or "agent"/"chat"/"sdk" for headless sessions
        ///
        /// Defaults to "pty" for CLI-created tasks.
        #[arg(long)]
        agent_type: Option<String>,

        /// Optional model override
        #[arg(long)]
        model: Option<String>,

        /// Optional provider-native reasoning effort override
        #[arg(long)]
        effort: Option<String>,

        /// Optional permission mode override
        #[arg(long)]
        permission_mode: Option<String>,

        /// Allowed tool override. Repeat to pass multiple values.
        #[arg(long)]
        allowed_tool: Vec<String>,

        /// Task that blocks this task. Repeat to pass multiple blockers.
        #[arg(long)]
        blocker_task_id: Vec<String>,

        /// Durable work item this is genuinely a semantic subtask of. Omit for
        /// ordinary top-level work and creator/orchestrator ownership.
        #[arg(long)]
        parent_task: Option<String>,
    },
    /// Request a new revision task from an existing task branch
    RequestRevision {
        /// The source task ID
        #[arg(long)]
        task_id: String,

        /// Stage to create the revision task in
        #[arg(long, default_value = "in progress")]
        target_stage: String,

        /// Human-readable summary of why revision is needed
        #[arg(long)]
        summary: String,

        /// Prompt for the revision task
        #[arg(long)]
        prompt: String,

        /// Optional JSON string with extra metadata
        #[arg(long)]
        metadata: Option<String>,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Send feedback or instructions to a running agent task
    SendInput {
        /// The target task ID
        #[arg(long)]
        task_id: String,

        /// Message to send to the running agent session
        #[arg(long)]
        message: String,

        /// Who is speaking: "operator" for a human or a human's relayed words,
        /// "manager" for an orchestrating agent's own instruction. Recorded
        /// with the message as declared; omit it to claim nothing
        #[arg(long)]
        source: Option<String>,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Write discrete terminal keys, or explicit raw bytes, into a running
    /// task's PTY without appending Enter or sending a logical message
    SendRawInput {
        /// The target task ID
        #[arg(long)]
        task_id: String,

        /// Named keys to write, in order, comma-separated
        /// (for example `--keys down,enter`). Mutually exclusive with --bytes
        #[arg(long, value_delimiter = ',')]
        keys: Vec<String>,

        /// Explicit bytes to write verbatim, hex by default
        /// (for example `--bytes 1b5b42`). The shell never interprets this:
        /// it is decoded here, not by a `printf`. Mutually exclusive with --keys
        #[arg(long)]
        bytes: Option<String>,

        /// How --bytes is spelled: hex (default) or base64
        #[arg(long)]
        encoding: Option<String>,

        /// Who is acting: "operator" for a human or a human's relayed
        /// instruction, "manager" for an orchestrating agent driving the
        /// terminal on its own authority. Recorded as declared; omit it to
        /// claim nothing
        #[arg(long)]
        source: Option<String>,

        /// List the accepted key names and exit without writing anything
        #[arg(long)]
        list_keys: bool,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Rename a task by setting its display name
    Rename {
        /// The task ID
        #[arg(long)]
        task_id: String,

        /// New task title
        #[arg(long)]
        name: String,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Advance an accepted task to the next workflow stage
    AdvanceStage {
        /// The accepted task ID
        #[arg(long)]
        task_id: String,

        /// Declared transition source: "operator" or "manager"
        #[arg(long, value_parser = ["operator", "manager"])]
        source: Option<String>,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Deliver an explicit approval to the merge singleton
    SignalMerge {
        /// Approved task ID
        #[arg(long)]
        task_id: String,

        /// Resolved PR head branch
        #[arg(long)]
        branch: String,

        /// Resolved PR base branch
        #[arg(long)]
        target: String,

        /// Pull-request URL, when one exists
        #[arg(long)]
        pr_url: Option<String>,

        /// Concise task or PR summary
        #[arg(long)]
        summary: String,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Rerun the current workflow stage for a task
    RerunStage {
        /// The task ID to rerun
        #[arg(long)]
        task_id: String,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Recover a dead task session, preserving provider context when possible
    Resume {
        /// The task ID to resume
        #[arg(long)]
        task_id: String,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Mark a task as blocked by one or more tasks
    Block {
        /// The task ID to block
        #[arg(long)]
        task_id: String,

        /// Task that blocks this task. Repeat to pass multiple blockers.
        #[arg(long)]
        blocker_task_id: Vec<String>,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Remove all blockers from a task
    Unblock {
        /// The task ID to unblock
        #[arg(long)]
        task_id: String,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Close a task (kills its sessions and hides it from the sidebar)
    Close {
        /// The task ID to close
        #[arg(long)]
        task_id: String,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Set or clear a task's parent so it nests as a subtask in the sidebar
    SetParent {
        /// The task ID to reparent
        #[arg(long)]
        task_id: String,

        /// Parent task ID. Omit to detach the task from its current parent.
        #[arg(long)]
        parent_task: Option<String>,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Send an operator-facing push notification to the Kanna mobile app
    NotifyMobile {
        /// Short notification title shown to the operator
        #[arg(long)]
        title: String,

        /// Concise notification message shown to the operator
        #[arg(long)]
        body: String,

        /// Optional durable task ID to open when the operator taps the notification
        #[arg(long)]
        task_id: Option<String>,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Change an open task's pinned workflow without restarting its live run
    SetWorkflow {
        /// The task ID whose workflow should change
        #[arg(long)]
        task_id: String,

        /// Workflow definition to pin
        #[arg(long)]
        workflow_name: String,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Watch several tasks at once and return their events since a cursor
    WaitEvents {
        /// Task IDs (or branch names) to watch; repeat or comma-separate
        #[arg(long = "task-id", value_delimiter = ',')]
        task_id: Vec<String>,

        /// Watch this task's direct children instead of naming their ids; pass
        /// your own task id to watch everything you fanned out
        #[arg(long)]
        parent_task_id: Option<String>,

        /// Watch every task in this repo instead of naming ids
        #[arg(long)]
        repo_id: Option<String>,

        /// Watch every task in repository clones with this remote URL hash
        #[arg(long)]
        repo_remote_url_hash: Option<String>,

        /// Drop these tasks' events (ids or branch names) from the chosen
        /// scope; repeat or comma-separate. A filter, not a scope, so it
        /// never invalidates a cursor. Inside a task session a repository
        /// scope adds the calling task automatically.
        #[arg(long = "exclude-task-id", value_delimiter = ',')]
        exclude_task_id: Vec<String>,

        /// Keep the calling task's own events in a repository-scoped wait
        /// issued from a task session (disables the automatic self-exclusion
        /// only; explicit --exclude-task-id values still apply)
        #[arg(long)]
        include_self: bool,

        /// Restrict the wait to the connected server instead of aggregating peers
        #[arg(long)]
        local_only: bool,

        /// Also return level-triggered settled runtime state
        #[arg(long)]
        include_current_activity: bool,

        /// Return a short process-local cursor handle for agent use
        #[arg(long, default_value_t = true, action = clap::ArgAction::Set)]
        short_cursor: bool,

        /// Start a cursorless watch at the current event tail (`now`)
        #[arg(long, value_parser = ["now"])]
        from: Option<String>,

        /// Cursor from the previous call; omit to receive retained history
        #[arg(long)]
        cursor: Option<String>,

        /// Maximum seconds to block, clamped to 240 so the wait returns inside
        /// the tools/call timeout MCP clients enforce; a wait that runs out
        /// reports waitOutcome 'timeout' and can simply be called again
        #[arg(long, default_value_t = kanna_tool_catalog::DEFAULT_WAIT_TIMEOUT_SECS)]
        timeout_secs: u64,

        /// Maximum events in one response
        #[arg(long)]
        limit: Option<i64>,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Hold the task-event long poll open until actionable work arrives
    ///
    /// This process is the push-equivalent for agent harnesses: run it in the
    /// background, let process exit wake the agent, drain the printed events,
    /// then re-arm it with the printed cursor. Unlike MCP tool calls, the
    /// process can safely loop beyond the 240-second per-call clamp. MCP
    /// clients commonly abort calls around 300 seconds and lose the result,
    /// so arbitrarily long watches belong here rather than in
    /// `kanna_wait_events`.
    Watch {
        /// Task IDs (or branch names) to watch; repeat or comma-separate
        #[arg(
            long = "task-id",
            value_delimiter = ',',
            required_unless_present = "repo_id"
        )]
        task_id: Vec<String>,

        /// Watch every task in this repository. Task IDs take precedence when
        /// both scopes are supplied, matching the event feed contract. When
        /// run from inside a task session (KANNA_TASK_ID set), the calling
        /// task's own events are excluded so the watch never wakes its owner
        /// with its own settled-runtime edges; see --include-self.
        #[arg(long)]
        repo_id: Option<String>,

        /// Drop these tasks' events (ids or branch names) from the watch;
        /// repeat or comma-separate. A filter, not a scope, so a cursor
        /// printed before adding one still resumes.
        #[arg(long = "exclude-task-id", value_delimiter = ',')]
        exclude_task_id: Vec<String>,

        /// Keep the calling task's own events in a repository-scoped watch
        /// run from a task session, e.g. to observe your own run.finished.
        /// Disables the automatic self-exclusion only.
        #[arg(long)]
        include_self: bool,

        /// Resume from the final cursor printed by an earlier watch. Without
        /// this option the watch starts at the live tail and replays no history.
        #[arg(long)]
        cursor: Option<String>,

        /// Wake for every event, including engine mechanics normally filtered
        /// from manager notifications.
        #[arg(long = "all")]
        all_events: bool,

        /// Exit successfully after this many quiet seconds and print a
        /// `budget_expired` cursor record. Omit for an unlimited watch.
        #[arg(long)]
        budget_secs: Option<u64>,

        /// Stream actionable batches instead of exiting after the first one.
        /// With a budget, each actionable batch restarts the quiet window.
        #[arg(long)]
        follow: bool,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
}

#[derive(Subcommand)]
pub(crate) enum ToolCommands {
    /// Print the active catalog tools as MCP tools/list JSON
    List,
    /// Call any catalog-backed Kanna tool
    Call {
        /// Catalog tool name
        name: String,

        /// Tool arguments as a JSON object
        #[arg(long)]
        json: Option<String>,

        /// Tool argument as key=value. Repeat to pass multiple values.
        #[arg(long)]
        arg: Vec<String>,

        /// Machine id from `kanna-cli machine list`; omit it, or pass the
        /// current machine id, to use the local machine
        #[arg(long)]
        machine_id: Option<String>,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
}

#[derive(Subcommand)]
pub(crate) enum MachineCommands {
    /// List the current machine and reachable sibling machines
    List {
        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let cli = Cli::parse();

    match cli.command {
        Commands::Info { server_url } => {
            commands::info::run(server_url.as_deref()).await;
        }
        Commands::Guide {
            topic,
            json,
            server_url,
        } => {
            commands::guide::run(topic.as_deref(), json, server_url.as_deref()).await;
        }
        Commands::StageComplete {
            task_id,
            status,
            summary,
            metadata,
            server_url,
        } => {
            commands::stage_complete::run(
                task_id,
                status,
                summary,
                metadata,
                server_url.as_deref(),
            )
            .await;
        }
        Commands::Repo { command } => {
            commands::repo::run(command).await;
        }
        Commands::Task { command } => {
            commands::task::run(command).await;
        }
        Commands::Tool { command } => {
            commands::tool::run(command).await;
        }
        Commands::Machine { command } => {
            commands::tool::run_machine(command).await;
        }
    }
}

#[cfg(test)]
mod tests;
