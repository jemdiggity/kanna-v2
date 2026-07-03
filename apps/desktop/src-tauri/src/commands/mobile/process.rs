use std::path::PathBuf;
use tokio::process::Command;

pub(super) fn find_sidecar(name: &str) -> Result<PathBuf, String> {
    #[cfg(test)]
    if let Ok(dir) = std::env::var("KANNA_TEST_SIDECAR_DIR") {
        let dir = PathBuf::from(dir);
        let suffixed = dir.join(format!(
            "{}-{}",
            name,
            kanna_runtime_defaults::current_target_triple()
        ));
        if suffixed.exists() {
            return Ok(suffixed);
        }
        let unsuffixed = dir.join(name);
        if unsuffixed.exists() {
            return Ok(unsuffixed);
        }
    }

    kanna_runtime_defaults::resolve_binary_from_candidates(
        name,
        crate::commands::fs::sidecar_candidates(name),
        |_| Err(format!("mobile sidecar '{}' not found", name)),
    )
    .map(PathBuf::from)
}

pub(super) async fn stop_server_on_port(port: u16) -> Result<(), String> {
    let pids = server_pids_on_port(port).await?;
    if pids.is_empty() {
        return Ok(());
    }

    for pid in &pids {
        signal_process(*pid, libc::SIGTERM)?;
    }
    let _ = wait_for_server_port_to_close(port, 20).await;

    let remaining_pids = server_pids_on_port(port).await?;
    if remaining_pids.is_empty() {
        return Ok(());
    }

    for pid in remaining_pids {
        signal_process(pid, libc::SIGKILL)?;
    }
    wait_for_server_port_to_close(port, 20).await
}

pub(super) async fn server_pids_on_port(port: u16) -> Result<Vec<i32>, String> {
    let output = Command::new("/usr/sbin/lsof")
        .args(["-nP", "-ti", &format!("TCP:{port}"), "-sTCP:LISTEN"])
        .output()
        .await
        .map_err(|e| format!("failed to inspect kanna-server port owner: {}", e))?;
    if !output.status.success() {
        return Ok(Vec::new());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_lsof_pids(&stdout))
}

fn parse_lsof_pids(output: &str) -> Vec<i32> {
    output
        .lines()
        .filter_map(|line| line.trim().parse::<i32>().ok())
        .collect()
}

fn signal_process(pid: i32, signal: i32) -> Result<(), String> {
    let rc = unsafe { libc::kill(pid, signal) };
    if rc == 0 {
        Ok(())
    } else {
        Err(format!(
            "failed to signal stale kanna-server process {}: {}",
            pid,
            std::io::Error::last_os_error()
        ))
    }
}

async fn wait_for_server_port_to_close(port: u16, attempts: usize) -> Result<(), String> {
    for _ in 0..attempts {
        if server_pids_on_port(port).await?.is_empty() {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    Err(format!("stale kanna-server did not stop on port {}", port))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::mobile::tests::{free_loopback_port, process_is_running};
    use std::os::unix::process::ExitStatusExt;
    use std::process::Stdio;
    use std::time::Duration;
    use tokio::process::{Child, Command};

    #[test]
    fn parse_lsof_pids_ignores_non_pid_lines() {
        assert_eq!(parse_lsof_pids("123\nnot-a-pid\n456\n"), vec![123, 456]);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn stop_server_on_port_escalates_to_sigkill_when_sigterm_is_ignored() {
        let port = free_loopback_port();
        let mut child = start_sigterm_ignoring_listener(port).await;
        let child_pid = child.id().expect("listener should have pid");

        stop_server_on_port(port)
            .await
            .expect("shutdown should escalate and free the port");

        let status = child
            .wait()
            .await
            .expect("listener process should be reaped");
        assert_eq!(
            status.signal(),
            Some(libc::SIGKILL),
            "SIGTERM-ignoring listener should be killed with SIGKILL"
        );
        assert!(
            !process_is_running(child_pid),
            "SIGTERM-ignoring listener should no longer be running"
        );
        assert!(
            server_pids_on_port(port).await.unwrap().is_empty(),
            "port should not have remaining listener pids"
        );
        let rebound = std::net::TcpListener::bind(("127.0.0.1", port))
            .expect("port should be reusable after stale listener is killed");
        drop(rebound);
    }

    async fn start_sigterm_ignoring_listener(port: u16) -> Child {
        let script = r#"
import signal
import socket
import sys
import time

signal.signal(signal.SIGTERM, signal.SIG_IGN)
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sock.bind(("127.0.0.1", int(sys.argv[1])))
sock.listen(1)
while True:
    time.sleep(1)
"#;
        let mut child = Command::new("python3")
            .arg("-c")
            .arg(script)
            .arg(port.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("python3 should start SIGTERM-ignoring listener");
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while tokio::time::Instant::now() < deadline {
            if let Some(status) = child
                .try_wait()
                .expect("listener status should be readable")
            {
                panic!("SIGTERM-ignoring listener exited early with {status}");
            }
            if !server_pids_on_port(port).await.unwrap().is_empty() {
                return child;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let _ = child.kill().await;
        let _ = child.wait().await;
        panic!("timed out waiting for SIGTERM-ignoring listener on port {port}");
    }
}
