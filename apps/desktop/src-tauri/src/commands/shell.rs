use std::collections::HashMap;
use std::process::Command;

#[tauri::command]
pub async fn run_script(
    script: String,
    cwd: String,
    env: HashMap<String, String>,
) -> Result<String, String> {
    let output = Command::new("sh")
        .arg("-c")
        .arg(&script)
        .current_dir(&cwd)
        .envs(&env)
        .output()
        .map_err(|e| format!("failed to run script: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        Err(format!(
            "script exited with status {}: {}{}",
            output.status,
            stderr,
            stdout
        ))
    }
}
