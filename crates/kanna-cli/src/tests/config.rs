use super::*;

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
