use reqwest::Url;
use serde_json::Value;

#[tauri::command]
pub async fn post_cloud_task_snapshot(
    endpoint: String,
    id_token: String,
    snapshot: Value,
) -> Result<Value, String> {
    let url = validate_cloud_endpoint(&endpoint)?;
    let token = id_token.trim();
    if token.is_empty() {
        return Err("cloud task snapshot post requires an id token".to_string());
    }

    let response = reqwest::Client::new()
        .post(url)
        .bearer_auth(token)
        .json(&snapshot)
        .send()
        .await
        .map_err(|e| format!("cloud task snapshot post failed: {}", e))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "cloud task snapshot post failed with status {}{}",
            status.as_u16(),
            if body.trim().is_empty() {
                String::new()
            } else {
                format!(": {}", body)
            },
        ));
    }

    if body.trim().is_empty() {
        return Ok(serde_json::json!({ "ok": true }));
    }

    serde_json::from_str(&body)
        .map_err(|e| format!("cloud task snapshot response was not valid JSON: {}", e))
}

fn validate_cloud_endpoint(endpoint: &str) -> Result<Url, String> {
    let url = Url::parse(endpoint.trim())
        .map_err(|e| format!("invalid cloud task snapshot endpoint: {}", e))?;
    match url.scheme() {
        "http" | "https" => Ok(url),
        scheme => Err(format!(
            "invalid cloud task snapshot endpoint scheme: {}",
            scheme
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::validate_cloud_endpoint;

    #[test]
    fn validate_cloud_endpoint_allows_http_and_https() {
        assert!(validate_cloud_endpoint("https://example.test/upsert").is_ok());
        assert!(validate_cloud_endpoint("http://127.0.0.1:5001/upsert").is_ok());
    }

    #[test]
    fn validate_cloud_endpoint_rejects_non_http_schemes() {
        let error = validate_cloud_endpoint("file:///tmp/task.json").unwrap_err();

        assert!(error.contains("scheme: file"));
    }
}
