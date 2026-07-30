use std::fmt;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const LIFECYCLE_AUDIT_FILE: &str = "kanna-daemon-lifecycle.log";
static LIFECYCLE_AUDIT_PATH: OnceLock<PathBuf> = OnceLock::new();

pub(crate) enum CliAction {
    RunDaemon,
    Exit(i32),
}

pub(crate) fn handle_cli_args() -> CliAction {
    let mut args = std::env::args().skip(1);
    let Some(first) = args.next() else {
        return CliAction::RunDaemon;
    };
    match first.as_str() {
        "--version" | "-V" => {
            println!(
                "kanna-daemon {} ({} @ {})",
                env!("KANNA_VERSION"),
                env!("GIT_BRANCH"),
                env!("GIT_COMMIT")
            );
            CliAction::Exit(0)
        }
        "--help" | "-h" => {
            println!("kanna-daemon\n\nUsage: kanna-daemon [--version] [--help]");
            CliAction::Exit(0)
        }
        _ => CliAction::RunDaemon,
    }
}

pub(crate) fn app_support_dir() -> PathBuf {
    kanna_runtime_defaults::daemon_dir_for_current_runtime()
}

pub(crate) fn daemon_data_dir() -> PathBuf {
    app_support_dir()
}

pub(crate) fn lifecycle_audit_log_path(dir: &Path) -> PathBuf {
    dir.join(LIFECYCLE_AUDIT_FILE)
}

pub(crate) fn publish_current_log_link(dir: &Path, pid: u32) -> std::io::Result<PathBuf> {
    let pid_marker = format!("_{pid}_");
    let mut matches = std::fs::read_dir(dir)?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.starts_with("kanna-daemon_")
                        && name.contains(&pid_marker)
                        && name.ends_with(".log")
                })
        })
        .collect::<Vec<_>>();
    matches.sort();
    let target = matches.pop().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("per-process daemon log for pid {pid} was not found"),
        )
    })?;
    let link = dir.join("kanna-daemon.log");
    if std::fs::symlink_metadata(&link).is_ok() {
        std::fs::remove_file(&link)?;
    }
    std::os::unix::fs::symlink(&target, &link)?;
    Ok(target)
}

/// Initialize the stable, append-only daemon lifecycle audit.
///
/// This deliberately does not use `log`: it is the diagnostic fallback when
/// the normal logger cannot be configured or cannot open its per-process
/// file. Each write opens the file with `O_APPEND`, so both sides of a daemon
/// handoff can record their decisions while they briefly overlap.
pub(crate) fn init_lifecycle_audit(dir: &Path) -> std::io::Result<PathBuf> {
    let path = lifecycle_audit_log_path(dir);
    let _ = LIFECYCLE_AUDIT_PATH.set(path.clone());
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    file.flush()?;
    Ok(path)
}

pub(crate) fn lifecycle_audit(args: fmt::Arguments<'_>) {
    let timestamp_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let message = format!("at_ms={timestamp_ms} pid={} {args}\n", std::process::id());

    let result = LIFECYCLE_AUDIT_PATH
        .get()
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "daemon lifecycle audit was not initialized",
            )
        })
        .and_then(|path| {
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .and_then(|mut file| file.write_all(message.as_bytes()))
        });

    if let Err(error) = result {
        eprintln!(
            "kanna-daemon: lifecycle audit write failed: {error}; record={}",
            message.trim_end()
        );
    }
}

pub(crate) fn panic_log_path(dir: &Path, pid: u32, timestamp_secs: u64) -> PathBuf {
    dir.join(format!("kanna-daemon-panic_{pid}_{timestamp_secs}.log"))
}

pub(crate) fn install_panic_hook(dir: PathBuf) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic_info| {
        let timestamp_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or(0);
        let path = panic_log_path(&dir, std::process::id(), timestamp_secs);
        let backtrace = std::backtrace::Backtrace::force_capture();
        let thread = std::thread::current();
        let thread_name = thread.name().unwrap_or("<unnamed>");
        let message = format!(
            "kanna-daemon panic\npid={}\nthread={}\ninfo={}\n\nbacktrace:\n{}\n",
            std::process::id(),
            thread_name,
            panic_info,
            backtrace
        );

        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(&path, message);
        eprintln!("[panic] wrote daemon crash log to {}", path.display());
        previous(panic_info);
    }));
}
