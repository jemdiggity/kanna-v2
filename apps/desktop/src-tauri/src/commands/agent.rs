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

        Ok(kanna_runtime_defaults::strip_ansi_for_display(&raw))
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

#[cfg(test)]
mod tests {
    use kanna_runtime_defaults::strip_ansi_for_display;

    #[test]
    fn strip_ansi_usage_removes_color_codes() {
        assert_eq!(strip_ansi_for_display("\u{1b}[31mused\u{1b}[0m"), "used");
    }

    #[test]
    fn strip_ansi_usage_preserves_cursor_movement_readability() {
        assert_eq!(
            strip_ansi_for_display("used\u{1b}[3C42\u{1b}[2Bdone"),
            "used   42\n\ndone"
        );
    }

    #[test]
    fn strip_ansi_usage_removes_osc_sequences_and_carriage_returns() {
        assert_eq!(
            strip_ansi_for_display("a\u{1b}]0;title\u{7}b\rc\u{1b}]1;ignored\u{1b}\\d"),
            "abcd"
        );
    }

    #[test]
    fn strip_ansi_usage_preserves_utf8_and_drops_incomplete_escapes() {
        assert_eq!(strip_ansi_for_display("✓ café\u{1b}\u{1b}[31"), "✓ café");
    }
}
