use std::path::{Path, PathBuf};

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

pub(crate) fn socket_path(dir: &PathBuf) -> PathBuf {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    dir.hash(&mut hasher);
    let hash = hasher.finish() as u32;
    PathBuf::from(format!("/tmp/kanna-{:08x}.sock", hash))
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
