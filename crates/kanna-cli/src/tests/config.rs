use super::*;

#[test]
fn prefers_cli_specific_db_path() {
    let env = [("KANNA_CLI_DB_PATH", "/tmp/worktree.db")];

    assert_eq!(
        resolve_stage_db_path(&env),
        Ok("/tmp/worktree.db".to_string())
    );
}

#[test]
fn errors_when_cli_path_missing() {
    let env: [(&str, &str); 0] = [];
    assert_eq!(
        resolve_stage_db_path(&env),
        Err("KANNA_CLI_DB_PATH environment variable is not set".to_string())
    );
}

#[test]
fn uses_explicit_server_url_before_env_or_default() {
    let env = [("KANNA_SERVER_BASE_URL", "http://127.0.0.1:9999")];

    assert_eq!(
        resolve_server_base_url(&env, Some("http://127.0.0.1:5555")),
        "http://127.0.0.1:5555".to_string()
    );
}

#[test]
fn falls_back_to_default_local_server_url() {
    let env: [(&str, &str); 0] = [];

    assert_eq!(
        resolve_server_base_url(&env, None),
        "http://127.0.0.1:48120".to_string()
    );
}

#[test]
fn optional_server_url_only_uses_explicit_or_env_values() {
    let empty_env: [(&str, &str); 0] = [];
    assert_eq!(resolve_optional_server_base_url(&empty_env, None), None);

    let env = [("KANNA_SERVER_BASE_URL", "http://127.0.0.1:48129")];
    assert_eq!(
        resolve_optional_server_base_url(&env, None),
        Some("http://127.0.0.1:48129".to_string())
    );
    assert_eq!(
        resolve_optional_server_base_url(&env, Some("http://127.0.0.1:5555")),
        Some("http://127.0.0.1:5555".to_string())
    );
}
