use super::router;
use super::state::{
    AppState, TestMergeAgentRunner, TestRevisionRequester, TestStageAdvancer, TestStageCompleter,
    TestStageRerunner, TestTaskCloser, TestTaskCreator, TestTaskInputSender,
};
use crate::config::Config;
use crate::db::Db;
use axum::Router;
use std::sync::Arc;

pub(crate) fn test_router(desktop_id: &str, desktop_name: &str) -> Router {
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_TEST_DB_ID: AtomicUsize = AtomicUsize::new(1);
    let test_db_id = NEXT_TEST_DB_ID.fetch_add(1, Ordering::Relaxed);
    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: "/tmp/kanna-daemon".to_string(),
        db_path: Db::test_db_path(&format!("http-api-{desktop_id}-{test_db_id}")),
        kanna_cli_path: None,
        desktop_id: desktop_id.to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: desktop_name.to_string(),
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "0.0.0.0".to_string(),
        lan_port: 48120,
        pairing_store_path: format!("/tmp/kanna-pairings-{desktop_id}-{test_db_id}.json"),
    };
    let _ = Db::open_for_tests(&config.db_path).expect("open test db");
    router(Arc::new(AppState::new(config)))
}

pub(super) fn test_router_with_seed(
    desktop_id: &str,
    desktop_name: &str,
    seed: impl FnOnce(&Db),
) -> Router {
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_TEST_DB_ID: AtomicUsize = AtomicUsize::new(5_000);
    let test_db_id = NEXT_TEST_DB_ID.fetch_add(1, Ordering::Relaxed);
    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: "/tmp/kanna-daemon".to_string(),
        db_path: Db::test_db_path(&format!("http-api-{desktop_id}-{test_db_id}")),
        kanna_cli_path: None,
        desktop_id: desktop_id.to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: desktop_name.to_string(),
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "0.0.0.0".to_string(),
        lan_port: 48120,
        pairing_store_path: format!("/tmp/kanna-pairings-{desktop_id}-{test_db_id}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).expect("open test db");
    seed(&db);
    router(Arc::new(AppState::new(config)))
}

pub(super) fn test_state_with_seed(
    desktop_id: &str,
    desktop_name: &str,
    seed: impl FnOnce(&Db),
) -> Arc<AppState> {
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_TEST_DB_ID: AtomicUsize = AtomicUsize::new(6_000);
    let test_db_id = NEXT_TEST_DB_ID.fetch_add(1, Ordering::Relaxed);
    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: "/tmp/kanna-daemon".to_string(),
        db_path: Db::test_db_path(&format!("http-invoke-{desktop_id}-{test_db_id}")),
        kanna_cli_path: None,
        desktop_id: desktop_id.to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: desktop_name.to_string(),
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "0.0.0.0".to_string(),
        lan_port: 48120,
        pairing_store_path: format!("/tmp/kanna-pairings-invoke-{desktop_id}-{test_db_id}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).expect("open test db");
    seed(&db);
    Arc::new(AppState::new(config))
}

pub(super) fn test_state_with_task_input_sender(
    desktop_id: &str,
    desktop_name: &str,
    task_input_sender: TestTaskInputSender,
) -> Arc<AppState> {
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_TEST_DB_ID: AtomicUsize = AtomicUsize::new(7_000);
    let test_db_id = NEXT_TEST_DB_ID.fetch_add(1, Ordering::Relaxed);
    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: "/tmp/kanna-daemon".to_string(),
        db_path: Db::test_db_path(&format!("http-invoke-input-{desktop_id}-{test_db_id}")),
        kanna_cli_path: None,
        desktop_id: desktop_id.to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: desktop_name.to_string(),
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "0.0.0.0".to_string(),
        lan_port: 48120,
        pairing_store_path: format!(
            "/tmp/kanna-pairings-invoke-input-{desktop_id}-{test_db_id}.json"
        ),
    };
    let _ = Db::open_for_tests(&config.db_path).expect("open test db");
    Arc::new(AppState::with_task_input_sender(config, task_input_sender))
}

pub(super) fn test_router_with_task_creator(
    desktop_id: &str,
    desktop_name: &str,
    task_creator: TestTaskCreator,
) -> Router {
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_TEST_DB_ID: AtomicUsize = AtomicUsize::new(10_000);
    let test_db_id = NEXT_TEST_DB_ID.fetch_add(1, Ordering::Relaxed);
    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: "/tmp/kanna-daemon".to_string(),
        db_path: Db::test_db_path(&format!("http-api-{desktop_id}-{test_db_id}")),
        kanna_cli_path: None,
        desktop_id: desktop_id.to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: desktop_name.to_string(),
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "0.0.0.0".to_string(),
        lan_port: 48120,
        pairing_store_path: format!("/tmp/kanna-pairings-{desktop_id}-{test_db_id}.json"),
    };
    let _ = Db::open_for_tests(&config.db_path).expect("open test db");
    router(Arc::new(AppState::with_task_creator(config, task_creator)))
}

pub(super) fn test_router_with_seed_and_task_creator(
    desktop_id: &str,
    desktop_name: &str,
    seed: impl FnOnce(&Db),
    task_creator: TestTaskCreator,
) -> Router {
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_TEST_DB_ID: AtomicUsize = AtomicUsize::new(15_000);
    let test_db_id = NEXT_TEST_DB_ID.fetch_add(1, Ordering::Relaxed);
    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: "/tmp/kanna-daemon".to_string(),
        db_path: Db::test_db_path(&format!("http-api-{desktop_id}-{test_db_id}")),
        kanna_cli_path: None,
        desktop_id: desktop_id.to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: desktop_name.to_string(),
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "0.0.0.0".to_string(),
        lan_port: 48120,
        pairing_store_path: format!("/tmp/kanna-pairings-{desktop_id}-{test_db_id}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).expect("open test db");
    seed(&db);
    router(Arc::new(AppState::with_task_creator(config, task_creator)))
}

pub(super) fn test_router_with_merge_agent_runner(
    desktop_id: &str,
    desktop_name: &str,
    merge_agent_runner: TestMergeAgentRunner,
) -> Router {
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_TEST_DB_ID: AtomicUsize = AtomicUsize::new(20_000);
    let test_db_id = NEXT_TEST_DB_ID.fetch_add(1, Ordering::Relaxed);
    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: "/tmp/kanna-daemon".to_string(),
        db_path: Db::test_db_path(&format!("http-api-{desktop_id}-{test_db_id}")),
        kanna_cli_path: None,
        desktop_id: desktop_id.to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: desktop_name.to_string(),
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "0.0.0.0".to_string(),
        lan_port: 48120,
        pairing_store_path: format!("/tmp/kanna-pairings-{desktop_id}-{test_db_id}.json"),
    };
    let _ = Db::open_for_tests(&config.db_path).expect("open test db");
    router(Arc::new(AppState::with_merge_agent_runner(
        config,
        merge_agent_runner,
    )))
}

pub(super) fn test_router_with_task_input_sender(
    desktop_id: &str,
    desktop_name: &str,
    task_input_sender: TestTaskInputSender,
) -> Router {
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_TEST_DB_ID: AtomicUsize = AtomicUsize::new(25_000);
    let test_db_id = NEXT_TEST_DB_ID.fetch_add(1, Ordering::Relaxed);
    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: "/tmp/kanna-daemon".to_string(),
        db_path: Db::test_db_path(&format!("http-api-{desktop_id}-{test_db_id}")),
        kanna_cli_path: None,
        desktop_id: desktop_id.to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: desktop_name.to_string(),
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "0.0.0.0".to_string(),
        lan_port: 48120,
        pairing_store_path: format!("/tmp/kanna-pairings-{desktop_id}-{test_db_id}.json"),
    };
    let _ = Db::open_for_tests(&config.db_path).expect("open test db");
    router(Arc::new(AppState::with_task_input_sender(
        config,
        task_input_sender,
    )))
}

pub(super) fn test_router_with_task_closer(
    desktop_id: &str,
    desktop_name: &str,
    task_closer: TestTaskCloser,
) -> Router {
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_TEST_DB_ID: AtomicUsize = AtomicUsize::new(27_500);
    let test_db_id = NEXT_TEST_DB_ID.fetch_add(1, Ordering::Relaxed);
    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: "/tmp/kanna-daemon".to_string(),
        db_path: Db::test_db_path(&format!("http-api-{desktop_id}-{test_db_id}")),
        kanna_cli_path: None,
        desktop_id: desktop_id.to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: desktop_name.to_string(),
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "0.0.0.0".to_string(),
        lan_port: 48120,
        pairing_store_path: format!("/tmp/kanna-pairings-{desktop_id}-{test_db_id}.json"),
    };
    let _ = Db::open_for_tests(&config.db_path).expect("open test db");
    router(Arc::new(AppState::with_task_closer(config, task_closer)))
}

pub(super) fn test_router_with_stage_advancer(
    desktop_id: &str,
    desktop_name: &str,
    stage_advancer: TestStageAdvancer,
) -> Router {
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_TEST_DB_ID: AtomicUsize = AtomicUsize::new(28_500);
    let test_db_id = NEXT_TEST_DB_ID.fetch_add(1, Ordering::Relaxed);
    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: "/tmp/kanna-daemon".to_string(),
        db_path: Db::test_db_path(&format!("http-api-{desktop_id}-{test_db_id}")),
        kanna_cli_path: None,
        desktop_id: desktop_id.to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: desktop_name.to_string(),
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "0.0.0.0".to_string(),
        lan_port: 48120,
        pairing_store_path: format!("/tmp/kanna-pairings-{desktop_id}-{test_db_id}.json"),
    };
    let _ = Db::open_for_tests(&config.db_path).expect("open test db");
    router(Arc::new(AppState::with_stage_advancer(
        config,
        stage_advancer,
    )))
}

pub(super) fn test_router_with_stage_rerunner(
    desktop_id: &str,
    desktop_name: &str,
    stage_rerunner: TestStageRerunner,
) -> Router {
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_TEST_DB_ID: AtomicUsize = AtomicUsize::new(41_000);
    let test_db_id = NEXT_TEST_DB_ID.fetch_add(1, Ordering::Relaxed);
    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: "/tmp/kanna-daemon".to_string(),
        db_path: Db::test_db_path(&format!("http-api-rerun-{desktop_id}-{test_db_id}")),
        kanna_cli_path: None,
        desktop_id: desktop_id.to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: desktop_name.to_string(),
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "0.0.0.0".to_string(),
        lan_port: 48120,
        pairing_store_path: format!("/tmp/kanna-pairings-rerun-{desktop_id}-{test_db_id}.json"),
    };
    let _ = Db::open_for_tests(&config.db_path).expect("open test db");
    router(Arc::new(AppState::with_stage_rerunner(
        config,
        stage_rerunner,
    )))
}

pub(super) fn test_router_with_stage_completer(
    desktop_id: &str,
    desktop_name: &str,
    stage_completer: TestStageCompleter,
) -> Router {
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_TEST_DB_ID: AtomicUsize = AtomicUsize::new(29_000);
    let test_db_id = NEXT_TEST_DB_ID.fetch_add(1, Ordering::Relaxed);
    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: "/tmp/kanna-daemon".to_string(),
        db_path: Db::test_db_path(&format!("http-api-{desktop_id}-{test_db_id}")),
        kanna_cli_path: None,
        desktop_id: desktop_id.to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: desktop_name.to_string(),
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "0.0.0.0".to_string(),
        lan_port: 48120,
        pairing_store_path: format!("/tmp/kanna-pairings-{desktop_id}-{test_db_id}.json"),
    };
    let _ = Db::open_for_tests(&config.db_path).expect("open test db");
    router(Arc::new(AppState::with_stage_completer(
        config,
        stage_completer,
    )))
}

pub(super) fn test_router_with_revision_requester(
    desktop_id: &str,
    desktop_name: &str,
    revision_requester: TestRevisionRequester,
) -> Router {
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_TEST_DB_ID: AtomicUsize = AtomicUsize::new(29_500);
    let test_db_id = NEXT_TEST_DB_ID.fetch_add(1, Ordering::Relaxed);
    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: "/tmp/kanna-daemon".to_string(),
        db_path: Db::test_db_path(&format!("http-api-{desktop_id}-{test_db_id}")),
        kanna_cli_path: None,
        desktop_id: desktop_id.to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: desktop_name.to_string(),
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "0.0.0.0".to_string(),
        lan_port: 48120,
        pairing_store_path: format!("/tmp/kanna-pairings-{desktop_id}-{test_db_id}.json"),
    };
    let _ = Db::open_for_tests(&config.db_path).expect("open test db");
    router(Arc::new(AppState::with_revision_requester(
        config,
        revision_requester,
    )))
}
