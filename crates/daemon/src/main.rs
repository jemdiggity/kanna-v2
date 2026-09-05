mod agent_runtime;
#[cfg(test)]
mod bench;
mod client;
mod connection;
mod daemon_lifecycle;
mod draft_bytes;
mod fanout;
mod fd;
mod fd_transfer;
mod handoff;
mod headless_terminal;
mod operator_auth;
mod output;
mod paths;
mod proc_info;
mod pty;
mod session;
mod socket;
mod startup;
mod successor_auth;
#[cfg(test)]
mod tests;
mod util;

use kanna_daemon::protocol;
pub use kanna_daemon::subprocess_env;

#[tokio::main]
async fn main() {
    startup::run_daemon().await;
}
