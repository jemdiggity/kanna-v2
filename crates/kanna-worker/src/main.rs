//! `kanna-worker` — the per-user supervisor that runs Kanna without a GUI.
//!
//! # Why this exists at all
//!
//! The daemon's trust roots are its **live direct parent**. At startup it
//! records kernel-derived executable paths for itself and for whoever launched
//! it, and it later refuses to hand sessions to a successor, or to accept a
//! server as an operator, unless that parent still matches
//! (`crates/daemon/src/successor_auth.rs`, `operator_auth.rs`).
//!
//! On macOS the app is that parent. On Linux the obvious shape — daemon and
//! server as two `systemd --user` units — cannot work, and not as a matter of
//! taste: the user manager holds capabilities, so the kernel marks it
//! non-dumpable and `/proc/<pid>/exe` is `EACCES` even to the same uid. A
//! daemon parented directly by `systemd --user` can never capture a trust root
//! and aborts by design. (Measured in
//! `docs/2026-09-07-linux-identity-pty-launcher-spike.md`.)
//!
//! So Linux needs an ordinary user binary between the service manager and the
//! daemon: readable through `/proc`, long-lived, and the direct parent of both
//! the daemon and the server. That is this program. It owns startup,
//! authorization and restarts, and nothing else — orchestration stays in
//! `kanna-server` and terminal authority stays in the daemon.
//!
//! It is portable rather than Linux-only on purpose: running the same
//! supervisor on macOS is what lets the headless exit-gate lane cover both.
//!
//! # Upgrades
//!
//! Executable-path comparisons are byte-exact and stay that way. Replacing a
//! binary in place makes the running process's `/proc/<pid>/exe` read
//! `… (deleted)`, so binaries are upgraded by replacing the file **and then
//! restarting** the supervisor and server. The incumbent daemon never re-reads
//! its own path, so daemon replacement across an upgrade still works.

mod config;
mod supervisor;
mod unit;

use std::process::ExitCode;

const USAGE: &str = "\
kanna-worker — run Kanna's daemon and server as a headless worker

USAGE:
    kanna-worker run [--data-dir DIR] [--db-path FILE] [--lan-port PORT]
                     [--transfer-port PORT]
    kanna-worker stop-daemon [--data-dir DIR]
    kanna-worker install-unit [--data-dir DIR] [--unit-path PATH]
    kanna-worker print-unit [--data-dir DIR]

COMMANDS:
    run            Supervise the daemon and the server until stopped.
                   SIGHUP  spawns a replacement daemon (sessions hand off).
                   SIGTERM stops the server and leaves the daemon running,
                           which is what closing the desktop app does.
    stop-daemon    Stop the daemon and every session it owns.
    install-unit   Write a systemd --user unit for this executable.
    print-unit     Print that unit to stdout instead of installing it.
";

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let command = args.next().unwrap_or_else(|| "run".to_string());
    let rest: Vec<String> = args.collect();

    let result = match command.as_str() {
        "run" => run_blocking(&rest),
        "stop-daemon" => stop_daemon_blocking(&rest),
        "install-unit" => unit::install(&rest),
        "print-unit" => unit::print(&rest),
        "-h" | "--help" | "help" => {
            print!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        other => Err(format!("unknown command {other:?}\n\n{USAGE}")),
    };

    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("kanna-worker: {error}");
            ExitCode::FAILURE
        }
    }
}

fn runtime() -> Result<tokio::runtime::Runtime, String> {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("failed to start the async runtime: {error}"))
}

fn run_blocking(args: &[String]) -> Result<(), String> {
    let options = config::Options::parse(args)?;
    runtime()?.block_on(supervisor::run(options))
}

fn stop_daemon_blocking(args: &[String]) -> Result<(), String> {
    let options = config::Options::parse(args)?;
    runtime()?.block_on(supervisor::stop_daemon(&options))
}
