use clap::{Parser, Subcommand};
use rusqlite::Connection;
use serde_json::Value;
use std::env;
use std::process;
use tokio::io::AsyncWriteExt;
use tokio::net::UnixStream;

#[derive(Parser)]
#[command(name = "kanna-cli")]
#[command(about = "Kanna pipeline stage signaling CLI")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
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
    },
}

fn write_stage_result_to_db(
    db_path: &str,
    task_id: &str,
    stage_result: &str,
) -> Result<(), String> {
    let conn = Connection::open(db_path).map_err(|e| format!("Failed to open database: {e}"))?;

    let rows_updated = conn
        .execute(
            "UPDATE pipeline_item SET stage_result = ? WHERE id = ?",
            rusqlite::params![stage_result, task_id],
        )
        .map_err(|e| format!("Failed to update pipeline_item: {e}"))?;

    if rows_updated == 0 {
        return Err(format!("No pipeline_item found with id '{task_id}'"));
    }

    Ok(())
}

async fn notify_socket(socket_path: &str, task_id: &str) -> Result<(), String> {
    let mut stream = UnixStream::connect(socket_path)
        .await
        .map_err(|e| format!("Failed to connect to socket: {e}"))?;

    let message = serde_json::json!({
        "type": "stage_complete",
        "task_id": task_id,
    });

    let mut payload =
        serde_json::to_string(&message).map_err(|e| format!("Failed to serialize message: {e}"))?;
    payload.push('\n');

    stream
        .write_all(payload.as_bytes())
        .await
        .map_err(|e| format!("Failed to write to socket: {e}"))?;

    stream
        .shutdown()
        .await
        .map_err(|e| format!("Failed to shutdown socket: {e}"))?;

    Ok(())
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let cli = Cli::parse();

    match cli.command {
        Commands::StageComplete {
            task_id,
            status,
            summary,
            metadata,
        } => {
            // Validate status
            if status != "success" && status != "failure" {
                eprintln!(
                    "Error: --status must be \"success\" or \"failure\", got \"{}\"",
                    status
                );
                process::exit(1);
            }

            // Validate metadata JSON if provided
            let metadata_value: Option<Value> = match &metadata {
                Some(json_str) => match serde_json::from_str(json_str) {
                    Ok(v) => Some(v),
                    Err(e) => {
                        eprintln!("Error: --metadata is not valid JSON: {e}");
                        process::exit(1);
                    }
                },
                None => None,
            };

            // Build stage_result JSON
            let mut stage_result = serde_json::json!({
                "status": status,
                "summary": summary,
            });

            if let Some(meta) = metadata_value {
                stage_result["metadata"] = meta;
            }

            let stage_result_str = serde_json::to_string(&stage_result).unwrap_or_else(|e| {
                eprintln!("Error: Failed to serialize stage_result: {e}");
                process::exit(1);
            });

            // Step 1: Write to DB (critical path)
            let db_path = env::var("KANNA_DB_PATH").unwrap_or_else(|_| {
                let home = env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
                format!("{home}/Library/Application Support/com.kanna.app/kanna-v2.db")
            });

            if let Err(e) = write_stage_result_to_db(&db_path, &task_id, &stage_result_str) {
                eprintln!("Error: {e}");
                process::exit(1);
            }

            // Step 2: Notify via Unix socket (best-effort)
            match env::var("KANNA_SOCKET_PATH") {
                Ok(socket_path) => {
                    if let Err(e) = notify_socket(&socket_path, &task_id).await {
                        eprintln!("Warning: Socket notification failed: {e}");
                        // Best-effort — still exit 0
                    }
                }
                Err(_) => {
                    eprintln!("Warning: KANNA_SOCKET_PATH not set, skipping socket notification");
                }
            }
        }
    }
}
