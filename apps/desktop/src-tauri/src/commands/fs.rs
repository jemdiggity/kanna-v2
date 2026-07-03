use serde::Serialize;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;
use tauri::AppHandle;
use tauri::Manager;

use base64::Engine;

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

fn format_log_timestamp<Tz>(timestamp: chrono::DateTime<Tz>) -> String
where
    Tz: chrono::TimeZone,
    Tz::Offset: std::fmt::Display,
{
    timestamp.format("%Y-%m-%d %H:%M:%S%.3f").to_string()
}

#[tauri::command]
pub fn get_app_data_dir(app: AppHandle) -> Result<String, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| format!("failed to get app data dir: {}", e))
}

#[derive(Serialize)]
pub struct AppBuildInfo {
    pub version: String,
    pub branch: String,
    pub commit_hash: String,
    pub worktree: String,
}

#[tauri::command]
pub fn get_app_build_info() -> AppBuildInfo {
    AppBuildInfo {
        version: crate::KANNA_VERSION.to_string(),
        branch: crate::KANNA_BUILD_BRANCH.to_string(),
        commit_hash: crate::KANNA_BUILD_COMMIT.to_string(),
        worktree: crate::KANNA_BUILD_WORKTREE.to_string(),
    }
}

#[tauri::command]
pub async fn get_pipeline_socket_path(
    state: tauri::State<'_, crate::PipelineSocketState>,
) -> Result<String, String> {
    state
        .lock()
        .await
        .clone()
        .ok_or_else(|| "pipeline socket path not initialized".to_string())
}

/// Resolve the built-in resources directory.
/// In release builds: `$RESOURCE/` (inside the app bundle).
/// In dev builds: walk up from cwd to find the repo root containing `.kanna/`.
fn builtin_resource_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    // Check the bundled resource dir first (works in release builds)
    if let Ok(resource_dir) = app.path().resource_dir() {
        if resource_dir.join(".kanna").is_dir() {
            return Ok(resource_dir);
        }
    }

    // Dev mode: walk up from cwd to find repo root with .kanna/
    if let Ok(mut dir) = std::env::current_dir() {
        for _ in 0..10 {
            if dir.join(".kanna").is_dir() {
                return Ok(dir);
            }
            if !dir.pop() {
                break;
            }
        }
    }

    Err("could not find .kanna/ directory in resource dir or any parent of cwd".to_string())
}

fn resolve_builtin_resource_path(base: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative_path);
    if path.components().any(|component| {
        matches!(
            component,
            Component::Prefix(_) | Component::RootDir | Component::ParentDir
        )
    }) {
        return Err(format!(
            "invalid resource path '{}': path must be relative and must not contain '..'",
            relative_path
        ));
    }

    Ok(base.join(path))
}

/// Read a file from the app's bundled resources directory.
/// `relative_path` is relative to the resources root (e.g., ".kanna/pipelines/default.json").
#[tauri::command]
pub fn read_builtin_resource(app: AppHandle, relative_path: String) -> Result<String, String> {
    let base = builtin_resource_dir(&app)?;
    let resource_path = resolve_builtin_resource_path(&base, &relative_path)?;
    std::fs::read_to_string(&resource_path).map_err(|e| {
        format!(
            "failed to read resource '{}': {}",
            resource_path.display(),
            e
        )
    })
}

/// List entries in a bundled resources subdirectory.
/// `relative_path` is relative to the resources root (e.g., ".kanna/agents").
#[tauri::command]
pub fn list_builtin_resources(
    app: AppHandle,
    relative_path: String,
) -> Result<Vec<String>, String> {
    let base = builtin_resource_dir(&app)?;
    let resource_path = resolve_builtin_resource_path(&base, &relative_path)?;
    if !resource_path.is_dir() {
        return Ok(Vec::new());
    }
    let mut names = Vec::new();
    for entry in std::fs::read_dir(&resource_path).map_err(|e| {
        format!(
            "failed to read resource dir '{}': {}",
            resource_path.display(),
            e
        )
    })? {
        let entry = entry.map_err(|e| format!("failed to read entry: {}", e))?;
        names.push(entry.file_name().to_string_lossy().to_string());
    }
    Ok(names)
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

#[derive(serde::Serialize)]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
}

#[tauri::command]
pub fn read_dir_entries(
    path: String,
    repo_root: String,
    show_all_files: Option<bool>,
) -> Result<Vec<DirEntry>, String> {
    use ignore::gitignore::GitignoreBuilder;
    use std::path::Path;

    let show_all_files = show_all_files.unwrap_or(false);

    let dir = Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("not a directory: {}", path));
    }

    // Build gitignore matcher rooted at repo_root
    let root = Path::new(&repo_root);
    let mut builder = GitignoreBuilder::new(root);

    // Walk up from repo_root to find all .gitignore files in the hierarchy
    fn add_gitignores(builder: &mut GitignoreBuilder, dir: &std::path::Path) {
        let gi = dir.join(".gitignore");
        if gi.exists() {
            if let Some(error) = builder.add(&gi) {
                eprintln!(
                    "[fs] failed to parse gitignore '{}': {}",
                    gi.display(),
                    error
                );
            }
        }
    }

    // Add repo root .gitignore
    add_gitignores(&mut builder, root);

    // Add .gitignore files along the path from root to target dir
    if let Ok(rel) = dir.strip_prefix(root) {
        let mut current = root.to_path_buf();
        for component in rel.components() {
            current = current.join(component);
            add_gitignores(&mut builder, &current);
        }
    }

    // Add global gitignore if it exists
    if let Some(global_path) = ignore::gitignore::gitconfig_excludes_path() {
        if global_path.is_file() {
            if let Some(error) = builder.add(&global_path) {
                eprintln!(
                    "[fs] failed to parse global gitignore '{}': {}",
                    global_path.display(),
                    error
                );
            }
        }
    }

    let gitignore = builder
        .build()
        .map_err(|e| format!("gitignore error: {}", e))?;

    let read =
        std::fs::read_dir(dir).map_err(|e| format!("failed to read dir '{}': {}", path, e))?;

    let mut entries: Vec<DirEntry> = Vec::new();

    for entry in read {
        let entry = entry.map_err(|e| format!("failed to read entry in '{}': {}", path, e))?;
        let name = entry.file_name().to_string_lossy().to_string();

        // Always skip .git directory
        if name == ".git" {
            continue;
        }

        let entry_path = entry.path();
        let is_dir = entry_path.is_dir();

        // Check gitignore for this entry only — not ancestors. The tree
        // explorer already hides ignored directories so users can't navigate
        // into them; checking ancestors would incorrectly hide all worktree
        // contents when the worktree sits under a gitignored path.
        let matched = gitignore.matched(&entry_path, is_dir);
        if !show_all_files && matched.is_ignore() {
            continue;
        }

        entries.push(DirEntry { name, is_dir });
    }

    // Sort: directories first, then files, both case-insensitive alphabetical
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
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
pub fn read_image_file_data_url(path: String) -> Result<String, String> {
    let mime_type = image_mime_type_for_path(&path)
        .ok_or_else(|| format!("unsupported image file type '{}'", path))?;
    let bytes = std::fs::read(&path).map_err(|e| format!("failed to read '{}': {}", path, e))?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{mime_type};base64,{encoded}"))
}

fn image_mime_type_for_path(path: &str) -> Option<&'static str> {
    let extension = Path::new(path).extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "apng" => Some("image/apng"),
        "avif" => Some("image/avif"),
        "bmp" => Some("image/bmp"),
        "gif" => Some("image/gif"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "svg" => Some("image/svg+xml"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

#[tauri::command]
pub fn which_binary(name: String) -> Result<String, String> {
    resolve_binary_from_candidates(&name, sidecar_candidates(&name))
}

fn resolve_binary_from_candidates(name: &str, candidates: Vec<PathBuf>) -> Result<String, String> {
    resolve_binary_from_candidates_with_path_lookup(name, candidates, |name| {
        kanna_runtime_defaults::which_binary(name)
            .map(|path| path.to_string_lossy().to_string())
            .ok_or_else(|| format!("binary '{}' not found in PATH", name))
    })
}

fn resolve_binary_from_candidates_with_path_lookup<F>(
    name: &str,
    candidates: Vec<PathBuf>,
    path_lookup: F,
) -> Result<String, String>
where
    F: FnOnce(&str) -> Result<String, String>,
{
    kanna_runtime_defaults::resolve_binary_from_candidates(name, candidates, path_lookup)
}

pub fn sidecar_candidates(name: &str) -> Vec<PathBuf> {
    kanna_runtime_defaults::sidecar_candidates(name)
}

fn bundled_cloud_env(app: &AppHandle) -> Option<&'static str> {
    kanna_runtime_defaults::desktop_cloud_environment_for_bundle_identifier(
        app.config().identifier.as_str(),
        cfg!(debug_assertions),
    )
    .map(|env| env.as_str())
}

fn bundled_mobile_server_port(app: &AppHandle) -> Option<u16> {
    kanna_runtime_defaults::mobile_server_port_for_bundle_identifier(
        app.config().identifier.as_str(),
        cfg!(debug_assertions),
    )
}

#[tauri::command]
pub fn read_env_var(app: AppHandle, name: String) -> Result<String, String> {
    match std::env::var(&name) {
        Ok(value) => Ok(value),
        Err(_) if name == "KANNA_CLOUD_ENV" => bundled_cloud_env(&app)
            .map(str::to_string)
            .ok_or_else(|| format!("{} not set", name)),
        Err(_) if name == "KANNA_MOBILE_SERVER_PORT" => bundled_mobile_server_port(&app)
            .map(|port| port.to_string())
            .ok_or_else(|| format!("{} not set", name)),
        Err(_) => Err(format!("{} not set", name)),
    }
}

#[tauri::command]
pub fn list_files(path: String) -> Result<Vec<String>, String> {
    let root = std::path::Path::new(&path);
    if !root.is_dir() {
        return Err(format!("not a directory: {}", path));
    }

    let repo =
        git2::Repository::discover(root).map_err(|e| format!("not a git repository: {}", e))?;
    let mut files = Vec::new();

    fn walk(
        dir: &std::path::Path,
        root: &std::path::Path,
        repo: &git2::Repository,
        out: &mut Vec<String>,
    ) {
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();

            // Always hide .git
            if name == ".git" {
                continue;
            }

            // Respect .gitignore via libgit2
            if repo.status_should_ignore(&path).unwrap_or(false) {
                continue;
            }

            if path.is_dir() {
                walk(&path, root, repo, out);
            } else if let Ok(rel) = path.strip_prefix(root) {
                out.push(rel.to_string_lossy().to_string());
            }
        }
    }

    walk(root, root, &repo, &mut files);
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
    let timestamp = format_log_timestamp(chrono::Local::now());
    writeln!(file, "{} {}", timestamp, message).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::{format_log_timestamp, image_mime_type_for_path, resolve_builtin_resource_path};
    use chrono::{Duration, FixedOffset, TimeZone};
    use std::path::Path;

    #[test]
    fn format_log_timestamp_includes_local_date_and_time() {
        let offset = FixedOffset::east_opt(9 * 60 * 60).expect("offset should exist");
        let timestamp = offset
            .with_ymd_and_hms(2026, 4, 19, 6, 55, 5)
            .single()
            .expect("timestamp should exist")
            + Duration::milliseconds(123);

        assert_eq!(format_log_timestamp(timestamp), "2026-04-19 06:55:05.123");
    }

    #[test]
    fn builtin_resource_path_accepts_normal_relative_paths() {
        let base = Path::new("/repo/resources");

        let resolved = resolve_builtin_resource_path(base, ".kanna/pipelines/default.json")
            .expect("normal relative resource path should resolve");

        assert_eq!(
            resolved,
            Path::new("/repo/resources/.kanna/pipelines/default.json")
        );
    }

    #[test]
    fn builtin_resource_path_rejects_parent_dir_traversal() {
        let base = Path::new("/repo/resources");

        let error = resolve_builtin_resource_path(base, ".kanna/../../../etc/passwd")
            .expect_err("parent directory traversal should be rejected");

        assert!(error.contains("invalid resource path"));
    }

    #[test]
    fn builtin_resource_path_rejects_absolute_paths() {
        let base = Path::new("/repo/resources");

        let error = resolve_builtin_resource_path(base, "/etc/passwd")
            .expect_err("absolute resource paths should be rejected");

        assert!(error.contains("invalid resource path"));
    }

    #[test]
    fn image_mime_type_accepts_supported_extensions_case_insensitively() {
        assert_eq!(
            image_mime_type_for_path("/tmp/screenshot.PNG"),
            Some("image/png")
        );
        assert_eq!(
            image_mime_type_for_path("/tmp/photo.jpeg"),
            Some("image/jpeg")
        );
        assert_eq!(
            image_mime_type_for_path("/tmp/diagram.svg"),
            Some("image/svg+xml")
        );
    }

    #[test]
    fn image_mime_type_rejects_non_image_extensions() {
        assert_eq!(image_mime_type_for_path("/tmp/readme.md"), None);
        assert_eq!(image_mime_type_for_path("/tmp/no-extension"), None);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardImagePayload {
    pub mime_type: String,
    pub png_base64: String,
    pub width: usize,
    pub height: usize,
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn read_clipboard_image_png() -> Result<Option<ClipboardImagePayload>, String> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|error| format!("failed to open clipboard: {error}"))?;
    let image = match clipboard.get_image() {
        Ok(image) => image,
        Err(arboard::Error::ContentNotAvailable) => return Ok(None),
        Err(error) => return Err(format!("failed to read clipboard image: {error}")),
    };

    let bytes = image.bytes.into_owned();
    let rgba = image::RgbaImage::from_vec(image.width as u32, image.height as u32, bytes)
        .ok_or_else(|| "clipboard image had an invalid RGBA payload".to_string())?;
    let dynamic = image::DynamicImage::ImageRgba8(rgba);
    let mut png = std::io::Cursor::new(Vec::new());
    dynamic
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(|error| format!("failed to encode clipboard image as PNG: {error}"))?;

    Ok(Some(ClipboardImagePayload {
        mime_type: "image/png".to_string(),
        png_base64: base64::engine::general_purpose::STANDARD.encode(png.into_inner()),
        width: image.width,
        height: image.height,
    }))
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn read_clipboard_image_png() -> Result<Option<ClipboardImagePayload>, String> {
    Ok(None)
}
