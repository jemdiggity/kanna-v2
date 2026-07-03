use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use tokio::sync::RwLock;

#[derive(Debug, serde::Deserialize)]
struct FirebaseLookupResponse {
    users: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, serde::Deserialize)]
struct FirebaseIdTokenClaims {
    iss: String,
    aud: String,
    exp: u64,
    iat: u64,
    auth_time: u64,
    sub: String,
}

#[derive(Debug, Default)]
struct FirebaseCertCache {
    certs: HashMap<String, String>,
    expires_at: Option<Instant>,
}

static FIREBASE_CERT_CACHE: OnceLock<RwLock<FirebaseCertCache>> = OnceLock::new();

const FIREBASE_CERTS_URL: &str =
    "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";

pub(super) async fn verify_firebase_id_token(
    config: &crate::config::Config,
    id_token: &str,
) -> Result<bool, String> {
    if config.firebase_auth_emulator_url.is_some() {
        return verify_firebase_id_token_against_auth_emulator(config, id_token).await;
    }

    verify_firebase_id_token_against_google(config, id_token).await
}

async fn verify_firebase_id_token_against_auth_emulator(
    config: &crate::config::Config,
    id_token: &str,
) -> Result<bool, String> {
    let Some(auth_emulator_url) = config.firebase_auth_emulator_url.as_deref() else {
        return Ok(false);
    };
    let base_url = auth_emulator_url.trim().trim_end_matches('/');
    if base_url.is_empty() {
        return Ok(false);
    }

    let url = format!(
        "{base_url}/identitytoolkit.googleapis.com/v1/accounts:lookup?key={}",
        config.firebase_project_id
    );
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|error| format!("failed to build Firebase ID token verifier: {error}"))?;
    let response = client
        .post(url)
        .json(&serde_json::json!({ "idToken": id_token }))
        .send()
        .await
        .map_err(|error| format!("failed to verify Firebase ID token: {error}"))?;
    if !response.status().is_success() {
        return Ok(false);
    }
    let body = response
        .json::<FirebaseLookupResponse>()
        .await
        .map_err(|error| format!("failed to parse Firebase ID token lookup response: {error}"))?;
    Ok(body.users.is_some_and(|users| !users.is_empty()))
}

async fn verify_firebase_id_token_against_google(
    config: &crate::config::Config,
    id_token: &str,
) -> Result<bool, String> {
    let header = decode_header(id_token)
        .map_err(|error| format!("failed to parse Firebase ID token header: {error}"))?;
    if header.alg != Algorithm::RS256 {
        return Ok(false);
    }
    let Some(kid) = header.kid else {
        return Ok(false);
    };

    let certs = firebase_securetoken_certs().await?;
    let Some(cert) = certs.get(&kid) else {
        return Ok(false);
    };

    let decoding_key = DecodingKey::from_rsa_pem(cert.as_bytes())
        .map_err(|error| format!("failed to parse Firebase signing cert: {error}"))?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.validate_exp = false;
    validation.required_spec_claims.clear();

    let token = decode::<FirebaseIdTokenClaims>(id_token, &decoding_key, &validation)
        .map_err(|error| format!("failed to verify Firebase ID token signature: {error}"))?;
    Ok(firebase_id_token_claims_are_valid(
        &token.claims,
        &config.firebase_project_id,
        unix_timestamp_now(),
    ))
}

async fn firebase_securetoken_certs() -> Result<HashMap<String, String>, String> {
    let cache = FIREBASE_CERT_CACHE.get_or_init(|| RwLock::new(FirebaseCertCache::default()));
    {
        let cached = cache.read().await;
        if cached
            .expires_at
            .is_some_and(|expires_at| Instant::now() < expires_at)
        {
            return Ok(cached.certs.clone());
        }
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|error| format!("failed to build Firebase cert client: {error}"))?;
    let response = client
        .get(FIREBASE_CERTS_URL)
        .send()
        .await
        .map_err(|error| format!("failed to fetch Firebase signing certs: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "failed to fetch Firebase signing certs: HTTP {}",
            response.status()
        ));
    }

    let max_age = response
        .headers()
        .get(reqwest::header::CACHE_CONTROL)
        .and_then(|value| value.to_str().ok())
        .and_then(cache_control_max_age)
        .unwrap_or(300);
    let certs = response
        .json::<HashMap<String, String>>()
        .await
        .map_err(|error| format!("failed to parse Firebase signing certs: {error}"))?;

    let mut cached = cache.write().await;
    cached.certs = certs.clone();
    cached.expires_at = Some(Instant::now() + Duration::from_secs(max_age));
    Ok(certs)
}

fn cache_control_max_age(value: &str) -> Option<u64> {
    value.split(',').find_map(|part| {
        let part = part.trim();
        let value = part.strip_prefix("max-age=")?;
        value.parse::<u64>().ok()
    })
}

fn unix_timestamp_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn firebase_id_token_claims_are_valid(
    claims: &FirebaseIdTokenClaims,
    firebase_project_id: &str,
    now: u64,
) -> bool {
    claims.iss == format!("https://securetoken.google.com/{firebase_project_id}")
        && claims.aud == firebase_project_id
        && claims.exp > now
        && claims.iat <= now
        && claims.auth_time <= now
        && !claims.sub.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn firebase_id_token_claims_accepts_securetoken_project() {
        let now = 1_800_000_000;
        let claims = FirebaseIdTokenClaims {
            iss: "https://securetoken.google.com/kanna-staging".to_string(),
            aud: "kanna-staging".to_string(),
            exp: now + 60,
            iat: now - 60,
            auth_time: now - 30,
            sub: "firebase-user-1".to_string(),
        };

        assert!(firebase_id_token_claims_are_valid(
            &claims,
            "kanna-staging",
            now
        ));
    }

    #[test]
    fn firebase_id_token_claims_reject_wrong_project() {
        let now = 1_800_000_000;
        let claims = FirebaseIdTokenClaims {
            iss: "https://securetoken.google.com/other-project".to_string(),
            aud: "other-project".to_string(),
            exp: now + 60,
            iat: now - 60,
            auth_time: now - 30,
            sub: "firebase-user-1".to_string(),
        };

        assert!(!firebase_id_token_claims_are_valid(
            &claims,
            "kanna-staging",
            now
        ));
    }
}
