//! Where the worker's files live and what goes in `server.toml`.
//!
//! Every path here is resolved through `kanna-runtime-defaults`, which is what
//! keeps the worker, the daemon, `kanna-server`, `kd` and the recovery sidecar
//! pointing at the same directory on both platforms.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Command-line options shared by every subcommand.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Options {
    /// The daemon/worker data directory. Defaults to the same directory the
    /// daemon would choose for itself, including its worktree inference.
    pub data_dir: PathBuf,
    pub lan_port: Option<u16>,
    pub transfer_port: Option<u16>,
    pub unit_path: Option<PathBuf>,
    /// Explicit database file.
    ///
    /// A worker with no way to name one could only ever be the machine's
    /// single canonical instance -- it would open the developer's real
    /// database from a test, and two worktrees could not run side by side,
    /// which is exactly what `kd` gives the desktop.
    pub db_path: Option<PathBuf>,
}

impl Options {
    pub fn parse(args: &[String]) -> Result<Self, String> {
        let mut data_dir: Option<PathBuf> = None;
        let mut lan_port = None;
        let mut transfer_port = None;
        let mut unit_path = None;
        let mut db_path = std::env::var_os("KANNA_DB_PATH")
            .map(PathBuf::from)
            .filter(|path| !path.as_os_str().is_empty());

        let mut index = 0;
        while index < args.len() {
            let flag = args[index].as_str();
            let value = || {
                args.get(index + 1)
                    .cloned()
                    .ok_or_else(|| format!("{flag} needs a value"))
            };
            match flag {
                "--data-dir" => {
                    data_dir = Some(PathBuf::from(value()?));
                    index += 2;
                }
                "--lan-port" => {
                    lan_port = Some(parse_port(&value()?, "--lan-port")?);
                    index += 2;
                }
                "--transfer-port" => {
                    transfer_port = Some(parse_port(&value()?, "--transfer-port")?);
                    index += 2;
                }
                "--unit-path" => {
                    unit_path = Some(PathBuf::from(value()?));
                    index += 2;
                }
                "--db-path" => {
                    db_path = Some(PathBuf::from(value()?));
                    index += 2;
                }
                other => return Err(format!("unknown option {other:?}")),
            }
        }

        Ok(Self {
            data_dir: match data_dir {
                Some(dir) => dir,
                None => default_data_dir()?,
            },
            lan_port,
            transfer_port,
            unit_path,
            db_path,
        })
    }

    pub fn server_config_path(&self) -> PathBuf {
        self.data_dir.join("server.toml")
    }

    pub fn server_log_path(&self) -> PathBuf {
        self.data_dir.join("kanna-server.log")
    }

    pub fn identity_path(&self) -> PathBuf {
        self.data_dir.join("worker-identity.json")
    }

    pub fn daemon_socket_path(&self) -> PathBuf {
        kanna_runtime_defaults::socket_path(&self.data_dir)
    }

    pub fn human_control_socket_path(&self) -> PathBuf {
        kanna_runtime_defaults::human_control_socket_path(&self.data_dir)
    }

    pub fn daemon_pid_path(&self) -> PathBuf {
        self.data_dir.join("daemon.pid")
    }

    /// The supervisor's own pid file. `stop-daemon` reads it to stop
    /// supervision before stopping the daemon.
    pub fn worker_pid_path(&self) -> PathBuf {
        self.data_dir.join("worker.pid")
    }

    pub fn lan_port(&self) -> u16 {
        self.lan_port
            .or_else(|| env_port("KANNA_MOBILE_SERVER_PORT"))
            .unwrap_or(48_120)
    }

    pub fn transfer_port(&self) -> u16 {
        self.transfer_port
            .or_else(|| env_port("KANNA_TRANSFER_PORT"))
            .unwrap_or(48_130)
    }

    /// The database this worker's server opens: the explicit one when given,
    /// otherwise the machine's canonical one.
    pub fn db_path(&self) -> PathBuf {
        self.db_path
            .clone()
            .unwrap_or_else(kanna_runtime_defaults::preferred_desktop_db_path)
    }

    pub fn api_base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.lan_port())
    }
}

fn parse_port(raw: &str, flag: &str) -> Result<u16, String> {
    raw.parse::<u16>()
        .ok()
        .filter(|port| *port != 0)
        .ok_or_else(|| format!("{flag} must be a nonzero port, got {raw:?}"))
}

fn env_port(name: &str) -> Option<u16> {
    std::env::var(name)
        .ok()?
        .trim()
        .parse::<u16>()
        .ok()
        .filter(|port| *port != 0)
}

/// The daemon directory this worker supervises.
///
/// `daemon_dir_for_current_runtime` is the same resolver the daemon itself
/// uses, so a worker started from inside a worktree supervises that worktree's
/// isolated instance rather than the machine's production one — which is what
/// makes parallel worktrees possible at all.
fn default_data_dir() -> Result<PathBuf, String> {
    let current_exe =
        std::env::current_exe().map_err(|error| format!("cannot resolve own path: {error}"))?;
    let current_dir =
        std::env::current_dir().map_err(|error| format!("cannot resolve cwd: {error}"))?;
    Ok(kanna_runtime_defaults::daemon_dir_for_runtime(
        std::env::var_os("KANNA_DAEMON_DIR")
            .map(PathBuf::from)
            .as_deref(),
        &current_exe,
        &current_dir,
        &home_dir(),
    ))
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| PathBuf::from("/tmp"))
}

/// This worker's stable identity, generated once and kept beside its config.
///
/// `kanna-server` treats `desktop_id` as the machine's identity — pairing,
/// transfers and the LAN API all key off it — so it must survive restarts. The
/// desktop persists an equivalent pair in its own app-data directory.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Identity {
    pub desktop_id: String,
    pub desktop_secret: String,
    pub desktop_name: String,
}

impl Identity {
    pub fn load_or_create(path: &Path) -> Result<Self, String> {
        if let Ok(bytes) = std::fs::read(path) {
            if let Ok(identity) = serde_json::from_slice::<Identity>(&bytes) {
                return Ok(identity);
            }
        }
        let identity = Identity {
            desktop_id: format!("worker-{}", random_hex(16)?),
            desktop_secret: random_hex(32)?,
            desktop_name: hostname(),
        };
        let bytes = serde_json::to_vec_pretty(&identity)
            .map_err(|error| format!("failed to encode worker identity: {error}"))?;
        write_private(path, &bytes)?;
        Ok(identity)
    }
}

/// Write a file only the owner can read: it carries `desktop_secret`, which is
/// a credential.
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .map_err(|error| format!("failed to write {}: {error}", path.display()))?;
    file.write_all(bytes)
        .map_err(|error| format!("failed to write {}: {error}", path.display()))
}

/// `desktop_secret` is a credential, so its bytes come from the kernel's
/// entropy pool and nowhere else -- never a seeded PRNG, and never a
/// timestamp. A failure here is fatal rather than silently weaker.
fn random_hex(bytes: usize) -> Result<String, String> {
    use std::io::Read;

    let mut buffer = vec![0u8; bytes];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut buffer))
        .map_err(|error| format!("failed to read kernel entropy: {error}"))?;
    Ok(buffer.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn hostname() -> String {
    let mut buffer = [0 as libc::c_char; 256];
    let ok = unsafe { libc::gethostname(buffer.as_mut_ptr(), buffer.len()) } == 0;
    if !ok {
        return "Kanna Worker".to_string();
    }
    // `c_char` is signed on x86-64 and unsigned on aarch64, so this cast is
    // meaningful on one architecture and a no-op on the other.
    #[allow(clippy::unnecessary_cast)]
    let bytes: Vec<u8> = buffer
        .iter()
        .take_while(|byte| **byte != 0)
        .map(|byte| *byte as u8)
        .collect();
    String::from_utf8(bytes).unwrap_or_else(|_| "Kanna Worker".to_string())
}

fn escape_toml_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

/// The `server.toml` a headless worker needs.
///
/// Deliberately local-only: `relay_url` and `device_token` are empty, so the
/// server never dials the relay and never expects a cloud credential. The LAN
/// listener binds loopback rather than `0.0.0.0`, because a worker exposes no
/// mobile surface until somebody asks it to. Everything else mirrors what the
/// desktop writes, field for field, so the same server code paths run.
pub fn build_server_config(
    options: &Options,
    identity: &Identity,
    kanna_cli_path: Option<&Path>,
) -> String {
    let db_path = options.db_path();
    let pairing_store_path = options.data_dir.join("mobile-pairings.json");
    let cli_line = kanna_cli_path
        .map(|path| {
            format!(
                "kanna_cli_path = \"{}\"\n",
                escape_toml_string(&path.to_string_lossy())
            )
        })
        .unwrap_or_default();

    format!(
        "relay_url = \"\"\n\
         device_token = \"\"\n\
         daemon_dir = \"{}\"\n\
         db_path = \"{}\"\n\
         {cli_line}\
         desktop_id = \"{}\"\n\
         desktop_secret = \"{}\"\n\
         desktop_name = \"{}\"\n\
         version = \"{}\"\n\
         environment = \"development\"\n\
         lan_host = \"127.0.0.1\"\n\
         lan_port = {}\n\
         transfer_port = {}\n\
         pairing_store_path = \"{}\"\n",
        escape_toml_string(&options.data_dir.to_string_lossy()),
        escape_toml_string(&db_path.to_string_lossy()),
        escape_toml_string(&identity.desktop_id),
        escape_toml_string(&identity.desktop_secret),
        escape_toml_string(&identity.desktop_name),
        escape_toml_string(env!("CARGO_PKG_VERSION")),
        options.lan_port(),
        options.transfer_port(),
        escape_toml_string(&pairing_store_path.to_string_lossy()),
    )
}

/// Peer identity for the transfer sidecar.
///
/// `kanna-server` requires these at transfer time and never derives them
/// itself, so the launcher owns them — the desktop does exactly the same. The
/// worker keys the peer to its own `desktop_id` instead of the desktop's
/// `transfer/identity.json`, which it does not have.
pub fn transfer_identity_env(_options: &Options, identity: &Identity) -> Vec<(String, String)> {
    let transfer_root = kanna_runtime_defaults::default_transfer_root();
    vec![
        (
            "KANNA_TRANSFER_ROOT".to_string(),
            env_override("KANNA_TRANSFER_ROOT")
                .unwrap_or_else(|| transfer_root.to_string_lossy().into_owned()),
        ),
        (
            "KANNA_TRANSFER_REGISTRY_DIR".to_string(),
            env_override("KANNA_TRANSFER_REGISTRY_DIR").unwrap_or_else(|| {
                transfer_root
                    .join("registry")
                    .to_string_lossy()
                    .into_owned()
            }),
        ),
        (
            "KANNA_TRANSFER_PEER_ID".to_string(),
            env_override("KANNA_TRANSFER_PEER_ID").unwrap_or_else(|| identity.desktop_id.clone()),
        ),
        (
            "KANNA_TRANSFER_DISPLAY_NAME".to_string(),
            env_override("KANNA_TRANSFER_DISPLAY_NAME")
                .unwrap_or_else(|| identity.desktop_name.clone()),
        ),
    ]
    .into_iter()
    .chain(
        env_override("KANNA_TRANSFER_DISCOVERY")
            .map(|value| ("KANNA_TRANSFER_DISCOVERY".to_string(), value)),
    )
    .collect()
}

fn env_override(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options() -> Options {
        Options {
            data_dir: PathBuf::from("/data/Kanna"),
            lan_port: Some(49000),
            transfer_port: Some(49001),
            unit_path: None,
            db_path: Some(PathBuf::from("/data/kanna.db")),
        }
    }

    fn identity() -> Identity {
        Identity {
            desktop_id: "worker-abc".to_string(),
            desktop_secret: "secret".to_string(),
            desktop_name: "box".to_string(),
        }
    }

    #[test]
    fn options_parse_ports_and_reject_zero() {
        let parsed = Options::parse(&[
            "--data-dir".to_string(),
            "/tmp/d".to_string(),
            "--lan-port".to_string(),
            "5000".to_string(),
        ])
        .expect("options should parse");
        assert_eq!(parsed.data_dir, PathBuf::from("/tmp/d"));
        assert_eq!(parsed.lan_port(), 5000);

        assert_eq!(
            Options::parse(&["--db-path".to_string(), "/tmp/x.db".to_string()])
                .expect("options should parse")
                .db_path(),
            PathBuf::from("/tmp/x.db")
        );

        assert!(Options::parse(&["--lan-port".to_string(), "0".to_string()]).is_err());
        assert!(Options::parse(&["--lan-port".to_string()]).is_err());
        assert!(Options::parse(&["--nope".to_string()]).is_err());
    }

    /// A headless worker is local-only: no relay URL and no device token means
    /// the server never dials the relay, and loopback means it exposes nothing
    /// to the network until somebody configures that deliberately.
    #[test]
    fn the_server_config_is_local_only() {
        let config = build_server_config(&options(), &identity(), None);

        assert!(config.contains("relay_url = \"\"\n"));
        assert!(config.contains("device_token = \"\"\n"));
        assert!(config.contains("lan_host = \"127.0.0.1\"\n"));
        assert!(config.contains("lan_port = 49000\n"));
        assert!(config.contains("transfer_port = 49001\n"));
        assert!(config.contains("daemon_dir = \"/data/Kanna\"\n"));
        assert!(config.contains("db_path = \"/data/kanna.db\"\n"));
        assert!(config.contains("desktop_id = \"worker-abc\"\n"));
    }

    #[test]
    fn a_cli_path_is_only_written_when_one_was_found() {
        assert!(!build_server_config(&options(), &identity(), None).contains("kanna_cli_path"));
        assert!(
            build_server_config(&options(), &identity(), Some(Path::new("/bin/kanna-cli")))
                .contains("kanna_cli_path = \"/bin/kanna-cli\"\n")
        );
    }

    /// The identity is a credential and is regenerated only when absent: a
    /// worker that forgot its `desktop_id` on every restart would look like a
    /// different machine to every paired device.
    #[test]
    fn identity_is_generated_once_and_kept_private() {
        use std::os::unix::fs::PermissionsExt;

        let dir =
            std::env::temp_dir().join(format!("kanna-worker-identity-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("worker-identity.json");

        let first = Identity::load_or_create(&path).expect("identity should be created");
        let second = Identity::load_or_create(&path).expect("identity should be reused");

        assert_eq!(first.desktop_id, second.desktop_id);
        assert_eq!(first.desktop_secret, second.desktop_secret);
        assert!(first.desktop_id.starts_with("worker-"));
        assert_ne!(first.desktop_secret, first.desktop_id);
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn toml_strings_escape_quotes_and_backslashes() {
        assert_eq!(escape_toml_string(r#"a"b\c"#), r#"a\"b\\c"#);
    }
}
