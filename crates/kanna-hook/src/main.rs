//! kanna-hook — sends hook event notifications to the Kanna daemon.
//!
//! Called by Claude Code hooks (via --settings) to notify the app of
//! lifecycle events (Stop, PostToolUse, StopFailure, etc.)
//!
//! Usage: kanna-hook <event> <session_id> [json_data]
//!
//! Examples:
//!   kanna-hook Stop abc123
//!   kanna-hook PostToolUse abc123 '{"tool":"Bash"}'

use std::io::Write;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;

fn daemon_socket_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("Kanna")
        .join("daemon.sock")
}

fn main() {
    let args: Vec<String> = std::env::args().collect();

    if args.len() < 3 {
        eprintln!("Usage: kanna-hook <event> <session_id> [json_data]");
        std::process::exit(1);
    }

    let event = &args[1];
    let session_id = &args[2];
    let data = if args.len() > 3 {
        match serde_json::from_str::<serde_json::Value>(&args[3]) {
            Ok(v) => Some(v),
            Err(_) => {
                // Treat as a plain string if not valid JSON
                Some(serde_json::Value::String(args[3].clone()))
            }
        }
    } else {
        None
    };

    let msg = serde_json::json!({
        "type": "HookEvent",
        "session_id": session_id,
        "event": event,
        "data": data,
    });

    let socket_path = daemon_socket_path();

    let mut stream = match UnixStream::connect(&socket_path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("kanna-hook: failed to connect to daemon at {:?}: {}", socket_path, e);
            std::process::exit(1);
        }
    };

    let mut json = serde_json::to_string(&msg).unwrap();
    json.push('\n');

    if let Err(e) = stream.write_all(json.as_bytes()) {
        eprintln!("kanna-hook: failed to write: {}", e);
        std::process::exit(1);
    }

    if let Err(e) = stream.flush() {
        eprintln!("kanna-hook: failed to flush: {}", e);
        std::process::exit(1);
    }
}
