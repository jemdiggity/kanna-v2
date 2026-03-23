use std::io::Write;
use std::process::Command;
use std::sync::OnceLock;
use tauri::AppHandle;
use tauri::Manager;

fn webview_log_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        // Worktree: derive suffix from KANNA_DAEMON_DIR
        // e.g. /path/.kanna-worktrees/task-abc123/.kanna-daemon → task-abc123
        if let Ok(dir) = std::env::var("KANNA_DAEMON_DIR") {
            let parts: Vec<&str> = dir.split('/').collect();
            if let Some(idx) = parts.iter().position(|p| *p == ".kanna-daemon") {
                if idx > 0 {
                    return format!("/tmp/kanna-webview-{}.log", parts[idx - 1]);
                }
            }
        }
        // Main instance: use a short hash of cwd so different checkouts don't collide
        if let Ok(cwd) = std::env::current_dir() {
            use std::hash::{Hash, Hasher};
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            cwd.hash(&mut hasher);
            let hash = hasher.finish();
            return format!("/tmp/kanna-webview-{:08x}.log", hash as u32);
        }
        "/tmp/kanna-webview.log".to_string()
    })
}

#[tauri::command]
pub fn get_app_data_dir(app: AppHandle) -> Result<String, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| format!("failed to get app data dir: {}", e))
}

#[tauri::command]
pub fn copy_file(src: String, dst: String) -> Result<(), String> {
    std::fs::copy(&src, &dst)
        .map(|_| ())
        .map_err(|e| format!("failed to copy '{}' to '{}': {}", src, dst, e))
}

#[tauri::command]
pub fn remove_file(path: String) -> Result<(), String> {
    std::fs::remove_file(&path).map_err(|e| format!("failed to remove '{}': {}", path, e))
}

#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<String>, String> {
    let dir = std::path::Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("not a directory: {}", path));
    }
    let mut names = Vec::new();
    for entry in
        std::fs::read_dir(dir).map_err(|e| format!("failed to read dir '{}': {}", path, e))?
    {
        let entry = entry.map_err(|e| format!("failed to read entry: {}", e))?;
        names.push(entry.file_name().to_string_lossy().to_string());
    }
    Ok(names)
}

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
    // Tauri externalBin appends the target triple to the binary name
    let sidecar_name = format!("{}-{}", name, current_target_triple());

    // First try next to the app binary (covers .build/debug/ and macOS bundle)
    let candidates = [
        // Tauri externalBin: triple-suffixed, same dir as exe
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join(&sidecar_name))),
        // Dev builds: plain name, same dir as exe
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join(&name))),
        // macOS bundle Resources
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("../Resources").join(&name))),
    ];
    for candidate in candidates.into_iter().flatten() {
        if candidate.exists() {
            return Ok(candidate.to_string_lossy().to_string());
        }
    }

    // Fall back to PATH
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

pub fn current_target_triple() -> &'static str {
    #[cfg(all(target_arch = "aarch64", target_os = "macos"))]
    { "aarch64-apple-darwin" }
    #[cfg(all(target_arch = "x86_64", target_os = "macos"))]
    { "x86_64-apple-darwin" }
}

#[tauri::command]
pub fn read_env_var(name: String) -> Result<String, String> {
    std::env::var(&name).map_err(|_| format!("{} not set", name))
}

#[tauri::command]
pub fn list_files(path: String) -> Result<Vec<String>, String> {
    let root = std::path::Path::new(&path);
    if !root.is_dir() {
        return Err(format!("not a directory: {}", path));
    }

    let skip_dirs = [
        ".git",
        "node_modules",
        "target",
        "dist",
        ".kanna-worktrees",
        ".turbo",
    ];
    let mut files = Vec::new();

    fn walk(dir: &std::path::Path, root: &std::path::Path, skip: &[&str], out: &mut Vec<String>) {
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') && name != ".claude" {
                continue;
            }
            if path.is_dir() {
                if skip.contains(&name.as_str()) {
                    continue;
                }
                walk(&path, root, skip, out);
            } else if let Ok(rel) = path.strip_prefix(root) {
                out.push(rel.to_string_lossy().to_string());
            }
        }
    }

    walk(root, root, &skip_dirs, &mut files);
    files.sort();
    Ok(files)
}

#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, &content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ensure_directory(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path)
        .map_err(|e| format!("Failed to create directory {}: {}", path, e))?;
    Ok(())
}

#[tauri::command]
pub fn append_log(message: String) -> Result<(), String> {
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(webview_log_path())
        .map_err(|e| e.to_string())?;
    let timestamp = chrono::Local::now().format("%H:%M:%S%.3f");
    writeln!(file, "{} {}", timestamp, message).map_err(|e| e.to_string())
}
