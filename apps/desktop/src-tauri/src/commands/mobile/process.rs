#[cfg(any(target_os = "linux", test))]
use std::collections::BTreeSet;
#[cfg(target_os = "linux")]
use std::path::Path;
use std::path::PathBuf;
#[cfg(not(target_os = "linux"))]
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

#[cfg(not(target_os = "linux"))]
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

#[cfg(target_os = "linux")]
pub(super) async fn server_pids_on_port(port: u16) -> Result<Vec<i32>, String> {
    tokio::task::spawn_blocking(move || linux_server_pids_on_port(Path::new("/proc"), port))
        .await
        .map_err(|error| format!("failed to inspect kanna-server port owner: {error}"))?
}

#[cfg(target_os = "linux")]
fn linux_server_pids_on_port(proc_root: &Path, port: u16) -> Result<Vec<i32>, String> {
    let mut socket_inodes = BTreeSet::new();
    let mut found_socket_table = false;
    for table_name in ["tcp", "tcp6"] {
        let table_path = proc_root.join("net").join(table_name);
        match std::fs::read_to_string(&table_path) {
            Ok(table) => {
                found_socket_table = true;
                socket_inodes.extend(listening_socket_inodes(&table, port));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "failed to inspect kanna-server port owner: could not read {}: {}",
                    table_path.display(),
                    error
                ));
            }
        }
    }
    if !found_socket_table {
        return Err(format!(
            "failed to inspect kanna-server port owner: no TCP socket table under {}",
            proc_root.display()
        ));
    }
    if socket_inodes.is_empty() {
        return Ok(Vec::new());
    }

    let process_entries = std::fs::read_dir(proc_root).map_err(|error| {
        format!(
            "failed to inspect kanna-server port owner: could not read {}: {}",
            proc_root.display(),
            error
        )
    })?;
    let mut pids = BTreeSet::new();
    for process_entry in process_entries.flatten() {
        let Some(pid) = process_entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<i32>().ok())
        else {
            continue;
        };
        let Ok(fd_entries) = std::fs::read_dir(process_entry.path().join("fd")) else {
            continue;
        };
        for fd_entry in fd_entries.flatten() {
            let Ok(target) = std::fs::read_link(fd_entry.path()) else {
                continue;
            };
            let Some(inode) = socket_inode_from_link(&target) else {
                continue;
            };
            if socket_inodes.contains(&inode) {
                pids.insert(pid);
                break;
            }
        }
    }
    Ok(pids.into_iter().collect())
}

#[cfg(any(target_os = "linux", test))]
fn listening_socket_inodes(table: &str, port: u16) -> BTreeSet<u64> {
    let port_hex = format!("{port:04X}");
    table
        .lines()
        .filter_map(|line| {
            let fields: Vec<_> = line.split_whitespace().collect();
            let local_port = fields.get(1)?.rsplit_once(':')?.1;
            let state = *fields.get(3)?;
            let inode = fields.get(9)?.parse::<u64>().ok()?;
            (local_port.eq_ignore_ascii_case(&port_hex) && state == "0A").then_some(inode)
        })
        .collect()
}

#[cfg(target_os = "linux")]
fn socket_inode_from_link(target: &std::path::Path) -> Option<u64> {
    target
        .to_str()?
        .strip_prefix("socket:[")?
        .strip_suffix(']')?
        .parse()
        .ok()
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
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            return Ok(());
        }
        Err(format!(
            "failed to signal stale kanna-server process {}: {}",
            pid, error
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
    use crate::commands::mobile::tests::process_is_running;
    use std::os::unix::process::ExitStatusExt;
    use std::process::Stdio;
    use std::time::Duration;
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::process::{Child, Command};

    #[test]
    fn parse_lsof_pids_ignores_non_pid_lines() {
        assert_eq!(parse_lsof_pids("123\nnot-a-pid\n456\n"), vec![123, 456]);
    }

    #[test]
    fn parses_listening_socket_inodes_for_the_requested_linux_port() {
        let table = "\
  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:12D9 00000000:0000 0A 00000000:00000000 00:00000000 00000000  501        0 12345 1
   1: 0100007F:12DA 00000000:0000 0A 00000000:00000000 00:00000000 00000000  501        0 23456 1
   2: 0100007F:12D9 00000000:0000 01 00000000:00000000 00:00000000 00000000  501        0 34567 1
";

        assert_eq!(
            listening_socket_inodes(table, 4825),
            std::collections::BTreeSet::from([12345])
        );
    }

    #[test]
    fn signal_process_treats_an_already_exited_process_as_stopped() {
        signal_process(i32::MAX, libc::SIGTERM)
            .expect("a process that no longer exists should already count as stopped");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn stop_server_on_port_escalates_to_sigkill_when_sigterm_is_ignored() {
        let (mut child, port) = start_sigterm_ignoring_listener().await;
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

    async fn start_sigterm_ignoring_listener() -> (Child, u16) {
        let script = r#"
import signal
import socket
import time

signal.signal(signal.SIGTERM, signal.SIG_IGN)
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sock.bind(("127.0.0.1", 0))
sock.listen(1)
print(sock.getsockname()[1], flush=True)
while True:
    time.sleep(1)
"#;
        let mut command = Command::new("python3");
        command
            .arg("-c")
            .arg(script)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = command
            .spawn()
            .expect("python3 should start SIGTERM-ignoring listener");
        let stdout = child
            .stdout
            .take()
            .expect("listener stdout should be piped");
        let mut lines = BufReader::new(stdout).lines();
        let ready = tokio::time::timeout(Duration::from_secs(5), lines.next_line()).await;
        let port = match ready {
            Ok(Ok(Some(line))) => line
                .trim()
                .parse::<u16>()
                .expect("listener should report a valid port"),
            Ok(Ok(None)) => panic!("listener closed stdout before reporting its port"),
            Ok(Err(error)) => panic!("failed to read listener port: {error}"),
            Err(_) => panic!("timed out waiting for listener port"),
        };
        (child, port)
    }
}
