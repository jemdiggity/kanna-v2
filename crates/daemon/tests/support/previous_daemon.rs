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
        let status = Command::new("cargo")
            .current_dir(root.join("source"))
            .env("CARGO_TARGET_DIR", root.join("target"))
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
