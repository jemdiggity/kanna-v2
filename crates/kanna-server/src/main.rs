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

use config::Config;
use futures_util::FutureExt;
use std::sync::Arc;
use std::time::Duration;

#[tokio::main]
async fn main() {
    env_logger::init();

    let args: Vec<String> = std::env::args().collect();
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

    let relay_url = config.relay_url.trim().to_string();
    log::info!(
        "kanna-server starting, relay: {}",
        if relay_url.is_empty() {
            "(disabled)"
        } else {
            &relay_url
        }
    );

    let heartbeat_config = config.clone();
    tokio::spawn(async move {
        loop {
            log::info!("desktop heartbeat tick for {}", heartbeat_config.desktop_id);
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        }
    });

    let _db = match db::Db::open(&config.db_path) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("Failed to open database at {}: {}", config.db_path, e);
            std::process::exit(1);
        }
    };

    log::info!("Database opened: {}", config.db_path);

    spawn_supervised("mobile Bonjour advertisement", {
        let config = config.clone();
        move || {
            let config = config.clone();
            async move {
                let _advertisement = bonjour::MobileBonjourAdvertisement::start(
                    &config.desktop_name,
                    &config.desktop_id,
                    config.lan_port,
                )?;
                futures_util::future::pending::<Result<(), String>>().await
            }
        }
    });

    // Capture the login-shell PATH before the first stage action needs it —
    // loading zshrc costs seconds and must never sit on a request path.
    tokio::task::spawn_blocking(task_creator::warm_login_shell_path);

    let http_state = Arc::new(http_api::AppState::new(config.clone()));
    let session_replacements = http_state.session_replacements();
    spawn_supervised("terminal watcher", {
        let config = config.clone();
        move || {
            let config = config.clone();
            let session_replacements = session_replacements.clone();
            async move {
                terminal_watcher::terminal_state_watcher_loop(config, session_replacements).await;
                Ok(())
            }
        }
    });
    let lan_task = tokio::spawn(http_api::serve(Arc::clone(&http_state)));
    if !relay_url.is_empty() {
        spawn_relay_supervised(config.clone(), Arc::clone(&http_state));
    }

    match lan_task.await {
        Ok(Ok(())) => log::warn!("HTTP API exited unexpectedly"),
        Ok(Err(err)) => log::error!("HTTP API failed: {}", err),
        Err(err) => log::error!("HTTP API task join error: {}", err),
    }
}

fn spawn_relay_supervised(config: Config, http_state: Arc<http_api::AppState>) {
    if let Err(error) = std::thread::Builder::new()
        .name("kanna-relay-supervisor".to_string())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(error) => {
                    log::error!("failed to start relay supervisor runtime: {error}");
                    return;
                }
            };
            let mut delay = Duration::from_millis(250);
            loop {
                let config = config.clone();
                let http_state = Arc::clone(&http_state);
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    runtime.block_on(async move {
                        let db = db::Db::open(&config.db_path)
                            .map_err(|error| format!("failed to open relay DB: {error}"))?;
                        relay::run_relay_loop(config, db, http_state).await
                    })
                }));
                match result {
                    Ok(Ok(())) => log::warn!("relay loop exited unexpectedly"),
                    Ok(Err(error)) => log::warn!("relay loop failed: {error}"),
                    Err(_) => log::error!("relay loop panicked"),
                }
                std::thread::sleep(delay);
                delay = std::cmp::min(delay * 2, Duration::from_secs(30));
            }
        })
    {
        log::error!("failed to spawn relay supervisor thread: {error}");
    }
}

fn spawn_supervised<F, Fut>(name: &'static str, make_task: F)
where
    F: Fn() -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = Result<(), String>> + Send + 'static,
{
    tokio::spawn(async move {
        let mut delay = Duration::from_millis(250);
        loop {
            let result = std::panic::AssertUnwindSafe(make_task())
                .catch_unwind()
                .await;
            match result {
                Ok(Ok(())) => log::warn!("{name} exited unexpectedly"),
                Ok(Err(error)) => log::warn!("{name} failed: {error}"),
                Err(_) => log::error!("{name} panicked"),
            }
            tokio::time::sleep(delay).await;
            delay = std::cmp::min(delay * 2, Duration::from_secs(30));
        }
    });
}
