//! Asking an installed agent CLI which version it is.
//!
//! A PTY task's spawn names `/bin/zsh`, not the agent CLI: the agent is
//! launched from inside a login-shell command line so repo setup runs first.
//! The daemon therefore cannot probe its own child, and the server — which
//! resolved the provider executable to an absolute path to build that command
//! line — passes the path along for this to probe.
//!
//! The probe never blocks a spawn. A session classifies from the
//! unknown-version union of its provider's rules until an answer lands, which
//! is exactly what it classified from before version gating existed.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use super::version::CliVersion;

/// Long enough for a Node CLI's cold start on a busy machine, short enough
/// that a wedged binary cannot hold a probe task open indefinitely.
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// Cache identity for an installed CLI. Size and mtime are what change when a
/// package manager replaces the binary, so an upgrade re-probes without anyone
/// having to invalidate anything.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ProbeKey {
    executable: String,
    args: Vec<String>,
    len: u64,
    modified_nanos: u128,
}

type ProbeCache = HashMap<ProbeKey, Option<CliVersion>>;

static CACHE: OnceLock<Mutex<ProbeCache>> = OnceLock::new();

fn cache() -> &'static Mutex<ProbeCache> {
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn probe_key(executable: &str, args: &[String]) -> Option<ProbeKey> {
    let metadata = std::fs::metadata(Path::new(executable)).ok()?;
    let modified_nanos = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|since_epoch| since_epoch.as_nanos())
        .unwrap_or(0);
    Some(ProbeKey {
        executable: executable.to_string(),
        args: args.to_vec(),
        len: metadata.len(),
        modified_nanos,
    })
}

fn cached(key: &ProbeKey) -> Option<Option<CliVersion>> {
    cache()
        .lock()
        .ok()
        .and_then(|guard| guard.get(key).cloned())
}

fn remember(key: ProbeKey, version: Option<CliVersion>) {
    if let Ok(mut guard) = cache().lock() {
        // A machine has a handful of installed CLIs, not thousands. The bound
        // exists so a pathological caller cannot grow this without limit.
        if guard.len() > 64 {
            guard.clear();
        }
        guard.insert(key, version);
    }
}

/// Run the CLI's version command, or answer from the cache.
///
/// `None` means "unknown", which is a first-class answer: it admits every rule
/// for the provider rather than narrowing to none.
pub async fn probe(
    executable: &str,
    args: &[String],
    cwd: &str,
    env: &HashMap<String, String>,
) -> Option<CliVersion> {
    if executable.is_empty() || args.is_empty() {
        return None;
    }
    let key = probe_key(executable, args)?;
    if let Some(cached) = cached(&key) {
        return cached;
    }

    let mut command = tokio::process::Command::new(executable);
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if Path::new(cwd).is_dir() {
        command.current_dir(cwd);
    }
    crate::subprocess_env::apply_child_env(
        &mut command,
        env.iter().map(|(key, value)| (key.clone(), value.clone())),
    );

    let version = match tokio::time::timeout(PROBE_TIMEOUT, command.output()).await {
        Ok(Ok(output)) => {
            // Several CLIs print their version on stderr. Read both rather
            // than pick one and be wrong about half of them.
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let parsed = CliVersion::parse(&stdout)
                .or_else(|| CliVersion::parse(&String::from_utf8_lossy(&output.stderr)));
            if parsed.is_none() {
                log::warn!(
                    "[detection] {executable} {} printed no recognisable version; \
                     this session will use every rule measured for its provider",
                    args.join(" ")
                );
            }
            parsed
        }
        Ok(Err(error)) => {
            log::warn!("[detection] could not run {executable} to read its version: {error}");
            None
        }
        Err(_) => {
            log::warn!("[detection] {executable} did not print a version within {PROBE_TIMEOUT:?}");
            None
        }
    };

    remember(key, version.clone());
    version
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    #[tokio::test]
    async fn a_missing_executable_is_unknown_rather_than_an_error() {
        let version = super::probe(
            "/nonexistent/kanna-detection-probe",
            &["--version".to_string()],
            "/tmp",
            &HashMap::new(),
        )
        .await;
        assert!(version.is_none());
    }

    #[tokio::test]
    async fn no_probe_arguments_means_no_probe() {
        let version = super::probe("/bin/echo", &[], "/tmp", &HashMap::new()).await;
        assert!(version.is_none());
    }

    #[tokio::test]
    async fn reads_a_version_out_of_stdout() {
        let version = super::probe(
            "/bin/echo",
            &["2.1.263 (Claude Code)".to_string()],
            "/tmp",
            &HashMap::new(),
        )
        .await
        .expect("echo must answer with a version");
        assert_eq!(version.raw(), "2.1.263");
    }
}
