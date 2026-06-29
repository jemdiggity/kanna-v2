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
pub(crate) enum Commands {
    /// Print the generated Kanna task manual for the current spawned task
    Guide {
        /// Print machine-readable JSON
        #[arg(long)]
        json: bool,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Signal that a pipeline stage is complete
    StageComplete {
        /// The task/pipeline_item ID
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
}

#[derive(Subcommand)]
pub(crate) enum TaskCommands {
    /// List recent tasks from the running desktop server
    List {
        /// Limit results to one repo ID instead of recent tasks across repos
        #[arg(long)]
        repo_id: Option<String>,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Search tasks by query text
    Search {
        /// Query text to search for
        #[arg(long)]
        query: String,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Show one recent task by exact ID
    Status {
        /// The task/pipeline_item ID
        #[arg(long)]
        task_id: String,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Fetch one task by exact ID
    Get {
        /// The task/pipeline_item ID
        #[arg(long)]
        task_id: String,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Wait for a task to finish or close
    Wait {
        /// The task/pipeline_item ID
        #[arg(long)]
        task_id: String,

        /// Maximum seconds to wait
        #[arg(long, default_value_t = 600)]
        timeout_secs: u64,

        /// Poll interval in seconds
        #[arg(long, default_value_t = 3)]
        poll_secs: u64,

        /// Condition to wait for: finished or closed
        #[arg(long, default_value = "finished")]
        until: String,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Print recent task logs
    Logs {
        /// The task/pipeline_item ID
        #[arg(long)]
        task_id: String,

        /// Number of recent relevant log events
        #[arg(long)]
        tail: Option<usize>,

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

        /// Optional pipeline name override
        #[arg(long)]
        pipeline_name: Option<String>,

        /// Optional base ref override
        #[arg(long)]
        base_ref: Option<String>,

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

        /// Optional permission mode override
        #[arg(long)]
        permission_mode: Option<String>,

        /// Allowed tool override. Repeat to pass multiple values.
        #[arg(long)]
        allowed_tool: Vec<String>,

        /// Task that blocks this task. Repeat to pass multiple blockers.
        #[arg(long)]
        blocker_task_id: Vec<String>,

        /// Task to notify when this task reaches a terminal state
        #[arg(long)]
        notify_task: Option<String>,

        /// Parent task this task is a subtask of
        #[arg(long)]
        parent_task: Option<String>,
    },
    /// Request a new revision task from an existing task branch
    RequestRevision {
        /// The source task/pipeline_item ID
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
        /// The target task/pipeline_item ID
        #[arg(long)]
        task_id: String,

        /// Message to send to the running agent session
        #[arg(long)]
        message: String,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Rename a task by setting its display name
    Rename {
        /// The task/pipeline_item ID
        #[arg(long)]
        task_id: String,

        /// New task title
        #[arg(long)]
        name: String,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Advance an accepted task to the next pipeline stage
    AdvanceStage {
        /// The accepted task/pipeline_item ID
        #[arg(long)]
        task_id: String,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Mark a task as blocked by one or more tasks
    Block {
        /// The task/pipeline_item ID to block
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
        /// The task/pipeline_item ID to unblock
        #[arg(long)]
        task_id: String,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Close a task (kills its sessions and hides it from the sidebar)
    Close {
        /// The task/pipeline_item ID to close
        #[arg(long)]
        task_id: String,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Set or clear a task's parent so it nests as a subtask in the sidebar
    SetParent {
        /// The task/pipeline_item ID to reparent
        #[arg(long)]
        task_id: String,

        /// Parent task ID. Omit to detach the task from its current parent.
        #[arg(long)]
        parent_task: Option<String>,

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

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let cli = Cli::parse();

    match cli.command {
        Commands::Guide { json, server_url } => {
            commands::guide::run(json, server_url.as_deref()).await;
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
    }
}

#[cfg(test)]
mod tests;
