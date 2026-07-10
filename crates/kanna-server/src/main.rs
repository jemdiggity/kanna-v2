mod bonjour;
mod commands;
mod config;
mod daemon_client;
mod db;
mod http_api;
mod ksp;
mod mobile_api;
mod pairing;
mod register;
mod relay;
mod relay_client;
mod session_replacements;
mod task_creator;
mod terminal_watcher;
mod worktree_cleanup;

use config::Config;
use std::sync::Arc;

/// Serializes unit tests that stage fake sidecars beside the shared test
/// executable. Those paths are process-wide, so every creator must hold this
/// guard until it has finished using and cleaning up the fixture.
#[cfg(test)]
static TEST_SIDECAR_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
pub(crate) fn test_sidecar_guard() -> std::sync::MutexGuard<'static, ()> {
    TEST_SIDECAR_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    match worktree_cleanup::run_cleanup_cli(&args[1..]) {
        Ok(true) => return,
        Ok(false) => {}
        Err(error) => {
            eprintln!("Worktree cleanup failed: {error}");
            std::process::exit(1);
        }
    }
    if args.get(1).map(|s| s.as_str()) == Some("register") {
        let relay_url = args
            .get(2)
            .cloned()
            .or_else(|| std::env::var("KANNA_RELAY_URL").ok())
            .map(|url| url.trim().to_string())
            .filter(|url| !url.is_empty());
        let Some(relay_url) = relay_url else {
            eprintln!("Registration requires a relay URL argument or KANNA_RELAY_URL.");
            std::process::exit(1);
        };
        if let Err(e) = register::register(&relay_url).await {
            eprintln!("Registration failed: {}", e);
            std::process::exit(1);
        }
        return;
    }

    let config = match Config::load() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Error: {}", e);
            std::process::exit(1);
        }
    };

    // Log to a file in the instance's daemon data dir (like the daemon
    // does), duplicated to stderr. The desktop app spawns this sidecar with
    // null stdio, so stderr-only logging would discard everything — the file
    // is the durable record of stage transitions and revision decisions.
    // RUST_LOG overrides the default filter.
    let _ = std::fs::create_dir_all(&config.daemon_dir);
    if let Ok(logger) = flexi_logger::Logger::try_with_env_or_str("kanna_server=info") {
        let _ = logger
            .log_to_file(
                flexi_logger::FileSpec::default()
                    .directory(&config.daemon_dir)
                    .discriminant(std::process::id().to_string()),
            )
            .duplicate_to_stderr(flexi_logger::Duplicate::Info)
            .start();
    }

    let relay_url = config.relay_url.trim().to_string();
    log::info!(
        "kanna-server starting, relay: {}",
        if relay_url.is_empty() {
            "(disabled)"
        } else {
            &relay_url
        }
    );

    if let Some((legacy_path, canonical_path)) =
        config::legacy_database_relocation_paths(&config.db_path)
    {
        match db::relocate_legacy_database_if_needed(&legacy_path, &canonical_path) {
            Ok(true) => log::info!(
                "Relocated legacy database: {} -> {}",
                legacy_path.display(),
                canonical_path.display()
            ),
            Ok(false) => {}
            Err(error) => {
                eprintln!("Failed to relocate legacy database: {error}");
                std::process::exit(1);
            }
        }
    }

    let heartbeat_config = config.clone();
    tokio::spawn(async move {
        loop {
            log::info!("desktop heartbeat tick for {}", heartbeat_config.desktop_id);
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        }
    });

    let db = match db::Db::open_migrated(&config.db_path) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("Failed to open database at {}: {}", config.db_path, e);
            std::process::exit(1);
        }
    };

    log::info!("Database opened: {}", config.db_path);

    let _mobile_bonjour = bonjour::MobileBonjourAdvertisement::start(
        &config.desktop_name,
        &config.desktop_id,
        config.lan_port,
    )
    .map_err(|error| {
        log::warn!("mobile Bonjour advertisement unavailable: {}", error);
        error
    })
    .ok();

    // Capture the login-shell PATH before the first stage action needs it —
    // loading zshrc costs seconds and must never sit on a request path.
    tokio::task::spawn_blocking(task_creator::warm_login_shell_path);
    let reconciliation_db_path = config.db_path.clone();
    tokio::task::spawn_blocking(move || match db::Db::open(&reconciliation_db_path) {
        Ok(db) => {
            if let Err(error) = worktree_cleanup::reconcile_leftover_worktrees(&db) {
                log::warn!("startup worktree cleanup reconciliation failed: {error}");
            }
        }
        Err(error) => {
            log::warn!("startup worktree cleanup could not open database: {error}");
        }
    });

    let http_state = Arc::new(http_api::AppState::new(config.clone()));
    let session_replacements = http_state.session_replacements();
    let terminal_state = Arc::clone(&http_state);
    tokio::spawn(async move {
        terminal_watcher::terminal_state_watcher_loop(terminal_state, session_replacements).await;
    });
    let lan_task = tokio::spawn(http_api::serve(Arc::clone(&http_state)));
    if relay_url.is_empty() {
        match lan_task.await {
            Ok(Ok(())) => log::warn!("LAN API exited unexpectedly"),
            Ok(Err(err)) => log::error!("LAN API failed: {}", err),
            Err(err) => log::error!("LAN API task join error: {}", err),
        }
    } else {
        let relay_loop = relay::run_relay_loop(config, db, http_state);
        tokio::pin!(relay_loop);

        tokio::select! {
            result = lan_task => match result {
                Ok(Ok(())) => log::warn!("LAN API exited unexpectedly"),
                Ok(Err(err)) => log::error!("LAN API failed: {}", err),
                Err(err) => log::error!("LAN API task join error: {}", err),
            },
            result = &mut relay_loop => match result {
                Ok(()) => log::warn!("relay loop exited unexpectedly"),
                Err(err) => log::error!("relay loop failed: {}", err),
            },
        };
    }
}
