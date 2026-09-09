//! Real server startup regression for the XDG_DATA_HOME-on-macOS incident.
//! The OS sandbox is independent of Kanna's guard: even running this test on
//! pre-guard code cannot read or write the owner's SQLite database.
#![cfg(target_os = "macos")]

use std::process::Command;

#[test]
fn installed_worker_fallback_requires_desktop_authorization_without_any_test_context() {
    let fixture = tempfile::tempdir().unwrap();
    // Model an installed executable, not a binary whose worktree location
    // independently triggers the isolation veto.
    let server = fixture.path().join("kanna-server");
    std::fs::copy(env!("CARGO_BIN_EXE_kanna-server"), &server).unwrap();
    assert!(kanna_runtime_defaults::worktree_root_for_path(&server).is_none());
    let protected = kanna_runtime_defaults::database_access::production_database_paths().unwrap();
    let account_home = protected[0].ancestors().nth(4).unwrap();
    let config = fixture.path().join("server.toml");
    let profile = r#"(version 1)
        (allow default)
        (deny file-read-data file-write* (regex #".*\.(db|sqlite)(-wal|-shm|-journal)?$"))"#;
    let sentinel = fixture.path().join("fence.db");
    std::fs::write(&sentinel, b"untouched").unwrap();
    let fence = Command::new("/usr/bin/sandbox-exec")
        .args(["-p", profile, "/usr/bin/touch"])
        .arg(&sentinel)
        .output()
        .expect("macOS sandbox must be available before attempting the regression");
    assert!(
        !fence.status.success(),
        "OS database fence must reject writes"
    );

    // A worker that loses --db-path materializes the canonical fallback in
    // server.toml. Exercise both platform paths and the server's own omitted
    // selection. Naming production explicitly is not desktop authorization.
    for db_path in [None, Some(&protected[0]), Some(&protected[2])] {
        let selection = db_path
            .map(|path| format!("db_path = {:?}\n", path.to_str().unwrap()))
            .unwrap_or_default();
        std::fs::write(&config, format!(
            "relay_url = \"\"\ndevice_token = \"\"\nversion = \"test\"\nenvironment = \"development\"\ntransfer_port = 4455\ndaemon_dir = {:?}\n{selection}",
            fixture.path().join("daemon").to_str().unwrap()
        )).unwrap();
        let output = Command::new("/usr/bin/sandbox-exec")
            .args(["-p", profile])
            .arg(&server)
            .env_clear()
            .env("HOME", account_home)
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .env("KANNA_SERVER_CONFIG", &config)
            .current_dir(fixture.path())
            .output()
            .expect("installed server should launch");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(!output.status.success(), "server must refuse startup");
        assert!(
            stderr.contains("requires deliberate KANNA_DESKTOP_DB_ACCESS=desktop authorization"),
            "must refuse for missing authorization, independently of test context: {stderr}"
        );
    }
    assert_eq!(std::fs::read(sentinel).unwrap(), b"untouched");
}

#[test]
fn xdg_only_test_isolation_cannot_open_the_desktop_database_even_with_inherited_authorization() {
    let fixture = tempfile::tempdir().unwrap();
    // Neither executable nor cwd may identify a worktree: this test must fail
    // if the macOS XDG veto is removed, even with desktop authorization.
    let server = fixture.path().join("kanna-server");
    std::fs::copy(env!("CARGO_BIN_EXE_kanna-server"), &server).unwrap();
    assert!(kanna_runtime_defaults::worktree_root_for_path(&server).is_none());
    // Use the OS account even when the surrounding test runner changed HOME.
    // The first protected path is HOME/Library/Application Support/build.kanna/kanna-v2.db.
    let protected = kanna_runtime_defaults::database_access::production_database_paths().unwrap();
    let account_home = protected[0].ancestors().nth(4).unwrap();
    let config = fixture.path().join("server.toml");
    std::fs::write(&config, format!(
        "relay_url = \"\"\ndevice_token = \"\"\nversion = \"test\"\nenvironment = \"development\"\ntransfer_port = 4455\ndaemon_dir = {:?}\n",
        fixture.path().join("daemon").to_str().unwrap()
    )).unwrap();

    // Deny all SQLite access, regardless of the eventual path. Configuration
    // and dynamic libraries remain readable. This is a test safety fence, not
    // the product protection being asserted below.
    let profile = r#"(version 1)
        (allow default)
        (deny file-read-data file-write* (regex #".*\.(db|sqlite)(-wal|-shm|-journal)?$"))"#;
    let sentinel = fixture.path().join("fence.db");
    std::fs::write(&sentinel, b"untouched").unwrap();
    let fence = Command::new("/usr/bin/sandbox-exec")
        .args(["-p", profile, "/usr/bin/touch"])
        .arg(&sentinel)
        .output()
        .expect("macOS sandbox must be available before attempting the regression");
    assert!(
        !fence.status.success(),
        "OS database fence must reject writes"
    );

    for inherited_desktop_authorization in [false, true] {
        let mut command = Command::new("/usr/bin/sandbox-exec");
        command
            .args(["-p", profile])
            .arg(&server)
            .env_clear()
            .env("HOME", account_home)
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .env("KANNA_SERVER_CONFIG", &config)
            .env("XDG_DATA_HOME", fixture.path().join("xdg"))
            .current_dir(fixture.path());
        if inherited_desktop_authorization {
            command.env("KANNA_DESKTOP_DB_ACCESS", "desktop");
        }
        let output = command.output().expect("server should launch");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(!output.status.success(), "server must refuse startup");
        assert!(
            stderr.contains("REFUSED: isolated/test/worktree process"),
            "{stderr}"
        );
        assert!(
            stderr.contains("XDG_DATA_HOME does not isolate macOS"),
            "{stderr}"
        );
    }
    assert_eq!(std::fs::read(sentinel).unwrap(), b"untouched");
}

#[path = "../src/worktree_cleanup/command.rs"]
mod cleanup_command;

#[test]
fn close_cleanup_restores_authorized_server_context_after_isolated_teardown() {
    // Re-exec outside the checkout, with the environment of an installed
    // desktop server. The test runner itself remains isolated.
    let fixture = tempfile::tempdir().unwrap();
    if std::env::var_os("KANNA_CLEANUP_GUARD_PROBE").is_none() {
        let probe = fixture.path().join("guard-test");
        std::fs::copy(std::env::current_exe().unwrap(), &probe).unwrap();
        let output = Command::new(probe)
            .args([
                "--exact",
                "close_cleanup_restores_authorized_server_context_after_isolated_teardown",
                "--nocapture",
            ])
            .env_clear()
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .env("KANNA_DESKTOP_DB_ACCESS", "desktop")
            .env("KANNA_CLEANUP_GUARD_PROBE", "1")
            .current_dir(fixture.path())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }

    let server = fixture.path().join("kanna-server");
    std::fs::copy(env!("CARGO_BIN_EXE_kanna-server"), &server).unwrap();
    let repo = fixture.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    let git = |args: &[&str]| {
        assert!(Command::new("/usr/bin/git")
            .args(args)
            .current_dir(&repo)
            .status()
            .unwrap()
            .success());
    };
    git(&["init"]);
    git(&[
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-m",
        "init",
    ]);
    let worktree = repo.join(".kanna-worktrees/task-cleanup");
    git(&[
        "worktree",
        "add",
        "-b",
        "task-cleanup",
        worktree.to_str().unwrap(),
    ]);
    let protected = kanna_runtime_defaults::database_access::production_database_paths().unwrap();
    let profile = r#"(version 1)
        (allow default)
        (deny file-read-data file-write* (regex #".*\.(db|sqlite)(-wal|-shm|-journal)?$"))"#;
    let sentinel = fixture.path().join("fence.db");
    std::fs::write(&sentinel, b"untouched").unwrap();
    assert!(!Command::new("/usr/bin/sandbox-exec")
        .args(["-p", profile, "/usr/bin/touch"])
        .arg(&sentinel)
        .status()
        .unwrap()
        .success());

    // This is the command builder used by append_close_cleanup_to_teardown.
    // The preceding repo teardown sees task isolation; only cleanup returns
    // to the authorized parent context and leaves the git worktree directory.
    let cleanup = cleanup_command::cleanup_shell_command(
        server.to_str().unwrap(),
        protected[0].to_str().unwrap(),
        repo.to_str().unwrap(),
        "missing-test-task",
    );
    let command = format!("test \"$KANNA_TASK_ID\" = task-cleanup && test \"$KANNA_WORKTREE\" = 1 || exit 90; {cleanup}");
    for isolated in [false, true] {
        let mut child = Command::new("/usr/bin/sandbox-exec");
        child
            .args(["-p", profile, "/bin/sh", "-c", &command])
            .env("KANNA_TASK_ID", "task-cleanup")
            .env("KANNA_WORKTREE", "1")
            .current_dir(&worktree);
        if isolated {
            child.env("XDG_DATA_HOME", fixture.path().join("xdg"));
        }
        let output = child.output().unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(!output.status.success());
        if isolated {
            assert!(
                stderr.contains("REFUSED: isolated/test/worktree"),
                "{stderr}"
            );
        } else {
            // Reaching SQLite's OS fence proves the actual cleanup environment
            // passed database_access::check. No production SQLite access occurs.
            assert!(stderr.contains("unable to open database file"), "{stderr}");
            assert!(!stderr.contains("REFUSED:"), "{stderr}");
        }
    }
    assert_eq!(std::fs::read(sentinel).unwrap(), b"untouched");
}
