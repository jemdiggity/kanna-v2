use std::process::Command;

#[tauri::command]
pub fn file_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("failed to read '{}': {}", path, e))
}

#[tauri::command]
pub fn which_binary(name: String) -> Result<String, String> {
    let output = Command::new("which")
        .arg(&name)
        .output()
        .map_err(|e| format!("failed to run which: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(format!("binary '{}' not found in PATH", name))
    }
}
