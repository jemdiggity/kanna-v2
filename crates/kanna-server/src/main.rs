mod commands;
mod config;
mod daemon_client;
mod db;

use config::Config;

#[tokio::main]
async fn main() {
    env_logger::init();

    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(|s| s.as_str()) == Some("register") {
        eprintln!("Registration not yet implemented");
        std::process::exit(1);
    }

    let config = match Config::load() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Error: {}", e);
            std::process::exit(1);
        }
    };

    log::info!("kanna-server starting, relay: {}", config.relay_url);
    log::info!("Connecting to daemon at {}", config.daemon_dir);

    match daemon_client::DaemonClient::connect(&config.daemon_dir).await {
        Ok(_client) => log::info!("Connected to daemon"),
        Err(e) => {
            eprintln!("Failed to connect to daemon: {}", e);
            std::process::exit(1);
        }
    }

    log::info!("kanna-server ready (relay connection not yet implemented)");
}
