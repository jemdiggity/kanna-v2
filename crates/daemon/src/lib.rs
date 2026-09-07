extern crate self as kanna_daemon;

pub mod agent;
pub mod bench;
pub mod detection;
pub mod draft_bytes;
pub mod fd;
pub mod headless_terminal;
pub mod proc_info;
mod process_inventory;
pub mod protocol;
pub mod pty;
pub mod reaper;
pub mod recovery;
pub mod session;
/// Session-id validation, shared with the recovery worker.
///
/// Re-exported rather than defined here: the worker is a SEPARATE process that also
/// derives `{id}.json` from protocol input, and two copies of "safe" is how one of
/// them ends up without the check.
pub use kanna_runtime_defaults::session_id;
pub mod subprocess_env;
pub mod terminal_perf;
