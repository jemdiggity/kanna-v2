use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

const PREVIOUS_TAG: &str = "v0.1.0-staging.1";

pub fn binary() -> PathBuf {
    if let Some(path) = std::env::var_os("KANNA_PREVIOUS_DAEMON_BIN") {
        return PathBuf::from(path);
    }

    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("crates directory")
        .parent()
        .expect("repository root")
        .to_path_buf();
    let commit = command_stdout(
        Command::new("git")
            .current_dir(&repo)
            .args(["rev-parse", PREVIOUS_TAG]),
    );
    let root = repo.join(".build/daemon-cross-version").join(format!(
        "{}-{}-{}",
        commit.trim(),
        std::env::consts::OS,
        std::env::consts::ARCH
    ));
    let binary = root.join("target/debug/kanna-daemon");
    if binary.is_file() {
        return binary;
    }

    let _lock = BuildLock::acquire(&root, &binary);
    if !binary.is_file() {
        materialize_archive(&repo, &root);
        let status = isolated_cargo_build(&root.join("source"), &root)
            .args([
                "build",
                "--locked",
                "-p",
                "kanna-daemon",
                "--bin",
                "kanna-daemon",
            ])
            .status()
            .expect("build previous daemon");
        assert!(status.success(), "previous daemon fixture build failed");
    }
    binary
}

/// Every environment spelling Cargo consults for its output directories, in
/// precedence order over a checkout's `.cargo/config.toml`.
pub const CARGO_DIRECTORY_ENV: [&str; 3] = [
    "CARGO_TARGET_DIR",
    "CARGO_BUILD_TARGET_DIR",
    "CARGO_BUILD_BUILD_DIR",
];

/// A `cargo` invocation that compiles `source` strictly into `root`.
///
/// Cargo reads these variables *before* the checkout's `.cargo/config.toml`, and
/// `kd` exports `CARGO_BUILD_BUILD_DIR` for every worktree. Inheriting them here
/// would compile the archived previous-release source into the *active*
/// worktree's build directory: that archive's `kanna-runtime-defaults` predates
/// the commit adding `session_id`, so it writes a `kanna_runtime_defaults` rlib
/// without that module into a tree the current sources also build into, and a
/// later current-source compile links the stale artifact and fails with
/// `E0432: no session_id in the root`. Two source revisions must never share one
/// Cargo fingerprint tree, so the inherited spellings are removed before the
/// fixture's own private directories are applied.
pub fn isolated_cargo_build(source: &Path, root: &Path) -> Command {
    let mut command = Command::new("cargo");
    command.current_dir(source);
    for key in CARGO_DIRECTORY_ENV {
        command.env_remove(key);
    }
    command
        .env("CARGO_TARGET_DIR", root.join("target"))
        .env("CARGO_BUILD_BUILD_DIR", root.join("cargo-build"));
    command
}

fn command_stdout(command: &mut Command) -> String {
    let output = command.output().expect("run fixture command");
    assert!(
        output.status.success(),
        "fixture command failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).expect("fixture command output is UTF-8")
}

fn materialize_archive(repo: &Path, root: &Path) {
    let source = root.join("source");
    if source.is_dir() {
        return;
    }
    std::fs::create_dir_all(root).expect("create fixture cache root");
    let staging = root.join(format!("source.staging-{}", std::process::id()));
    if staging.exists() {
        std::fs::remove_dir_all(&staging).expect("remove stale owned staging");
    }
    std::fs::create_dir_all(&staging).expect("create fixture staging");

    let mut archive = Command::new("git")
        .current_dir(repo)
        .args(["archive", PREVIOUS_TAG])
        .stdout(Stdio::piped())
        .spawn()
        .expect("start git archive");
    let archive_stdout = archive.stdout.take().expect("git archive stdout");
    let extract = Command::new("tar")
        .args(["-x", "-C"])
        .arg(&staging)
        .stdin(Stdio::from(archive_stdout))
        .status()
        .expect("extract previous source");
    let archived = archive.wait().expect("wait for git archive");
    assert!(archived.success(), "git archive failed");
    assert!(extract.success(), "tar extraction failed");
    std::fs::rename(staging, source).expect("publish previous source atomically");
}

struct BuildLock {
    path: Option<PathBuf>,
}

impl BuildLock {
    fn acquire(root: &Path, binary: &Path) -> Self {
        std::fs::create_dir_all(root).expect("create fixture cache root");
        let path = root.join("build.lock");
        loop {
            if binary.is_file() {
                return Self { path: None };
            }
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(_) => {
                    return Self { path: Some(path) };
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    let stale = std::fs::metadata(&path)
                        .and_then(|metadata| metadata.modified())
                        .and_then(|modified| modified.elapsed().map_err(std::io::Error::other))
                        .is_ok_and(|age| age > Duration::from_secs(15 * 60));
                    if stale {
                        let _ = std::fs::remove_file(&path);
                    } else {
                        std::thread::sleep(Duration::from_millis(100));
                    }
                }
                Err(error) => panic!("acquire previous-daemon build lock: {error}"),
            }
        }
    }
}

impl Drop for BuildLock {
    fn drop(&mut self) {
        if let Some(path) = self.path.take() {
            let _ = std::fs::remove_file(path);
        }
    }
}
