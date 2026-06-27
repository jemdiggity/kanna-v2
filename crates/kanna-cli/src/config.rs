use std::env;

pub(crate) const DEFAULT_SERVER_BASE_URL: &str = "http://127.0.0.1:48120";

pub(crate) fn env_var_from_pairs(env_pairs: &[(&str, &str)], key: &str) -> Option<String> {
    env_pairs
        .iter()
        .find_map(|(candidate, value)| (*candidate == key).then(|| (*value).to_string()))
}

pub(crate) fn resolve_stage_db_path(env_pairs: &[(&str, &str)]) -> Result<String, String> {
    if let Some(db_path) = env_var_from_pairs(env_pairs, "KANNA_CLI_DB_PATH") {
        return Ok(db_path);
    }

    Err("KANNA_CLI_DB_PATH environment variable is not set".to_string())
}

pub(crate) fn resolve_stage_db_path_from_env() -> Result<String, String> {
    let env_pairs = env::vars().collect::<Vec<_>>();
    let borrowed_pairs = env_pairs
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect::<Vec<_>>();
    resolve_stage_db_path(&borrowed_pairs)
}

pub(crate) fn resolve_server_base_url(
    env_pairs: &[(&str, &str)],
    explicit_server_url: Option<&str>,
) -> String {
    explicit_server_url
        .map(str::to_string)
        .or_else(|| env_var_from_pairs(env_pairs, "KANNA_SERVER_BASE_URL"))
        .unwrap_or_else(|| DEFAULT_SERVER_BASE_URL.to_string())
}

pub(crate) fn resolve_optional_server_base_url(
    env_pairs: &[(&str, &str)],
    explicit_server_url: Option<&str>,
) -> Option<String> {
    explicit_server_url
        .map(str::to_string)
        .or_else(|| env_var_from_pairs(env_pairs, "KANNA_SERVER_BASE_URL"))
}

pub(crate) fn resolve_server_base_url_from_env(explicit_server_url: Option<&str>) -> String {
    let env_pairs = env::vars().collect::<Vec<_>>();
    let borrowed_pairs = env_pairs
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect::<Vec<_>>();
    resolve_server_base_url(&borrowed_pairs, explicit_server_url)
}

pub(crate) fn resolve_guide_task_id(env_pairs: &[(&str, &str)]) -> Option<String> {
    env_var_from_pairs(env_pairs, "KANNA_TASK_ID")
}
