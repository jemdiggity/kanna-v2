/// Capture Claude CLI `/usage` output by piping it to stdin.
#[tauri::command]
pub async fn get_claude_usage() -> Result<String, String> {
    tokio::task::spawn_blocking(|| {
        let mut command = std::process::Command::new("bash");
        crate::subprocess_env::apply_child_env(
            &mut command,
            std::collections::HashMap::<String, String>::new(),
        );
        let output = command
            .args(["-lc", "echo '/usage' | claude"])
            .stdin(std::process::Stdio::null())
            .output()
            .map_err(|e| format!("failed to spawn: {e}"))?;

        let raw = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();

        if raw.is_empty() || !raw.contains("used") {
            return Err(format!(
                "failed to capture usage data (exit={:?}, stdout_len={}, stderr={})",
                output.status.code(),
                raw.len(),
                if stderr.is_empty() {
                    "(empty)"
                } else {
                    &stderr
                }
            ));
        }

        Ok(strip_ansi_usage(&raw))
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

/// Strip ANSI escape sequences from terminal output.
///
/// Converts CSI cursor-forward (`[<n>C`) to spaces and cursor-down (`[<n>B`)
/// to newlines so the result is roughly readable. All other escape sequences
/// (colors, cursor positioning, etc.) are discarded.
fn strip_ansi_usage(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let len = bytes.len();
    let mut i = 0;

    while i < len {
        match bytes[i] {
            0x1b => {
                i += 1;
                if i >= len {
                    break;
                }
                match bytes[i] {
                    b'[' => {
                        i += 1;
                        let param_start = i;
                        while i < len && !bytes[i].is_ascii_alphabetic() {
                            i += 1;
                        }
                        if i < len {
                            let cmd = bytes[i];
                            let params = &input[param_start..i];
                            i += 1;
                            match cmd {
                                b'C' => {
                                    let n: usize = params.parse().unwrap_or(1);
                                    for _ in 0..n {
                                        result.push(' ');
                                    }
                                }
                                b'B' => {
                                    let n: usize = params.parse().unwrap_or(1);
                                    for _ in 0..n {
                                        result.push('\n');
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                    b']' => {
                        i += 1;
                        while i < len {
                            if bytes[i] == 0x07 {
                                i += 1;
                                break;
                            }
                            if bytes[i] == 0x1b && i + 1 < len && bytes[i + 1] == b'\\' {
                                i += 2;
                                break;
                            }
                            i += 1;
                        }
                    }
                    _ => {
                        i += 1;
                    }
                }
            }
            b'\r' => {
                i += 1;
            }
            _ => {
                let byte = bytes[i];
                if byte >= 0x20 || byte == b'\n' || byte == b'\t' {
                    if byte < 0x80 {
                        result.push(byte as char);
                        i += 1;
                    } else {
                        let remaining = &input[i..];
                        if let Some(ch) = remaining.chars().next() {
                            result.push(ch);
                            i += ch.len_utf8();
                        } else {
                            i += 1;
                        }
                    }
                } else {
                    i += 1;
                }
            }
        }
    }

    result
}
