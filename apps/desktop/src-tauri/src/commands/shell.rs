use std::collections::HashMap;
use std::process::Command;

/// Ensure the Kanna zsh init directory exists with proxy rc files.
///
/// Returns the path to the directory (suitable for ZDOTDIR).
/// The init files set Kanna defaults (e.g. emacs keybindings) BEFORE
/// sourcing the user's own rc files, so users can override in ~/.zshrc.
#[tauri::command]
pub fn ensure_term_init() -> Result<String, String> {
    let dir = crate::daemon_data_dir().join("zsh");
    std::fs::create_dir_all(&dir).map_err(|e| format!("failed to create zsh init dir: {e}"))?;

    let zshenv = r#"# Kanna terminal — proxy to user's .zshenv
_kanna_home="${KANNA_ORIG_ZDOTDIR:-$HOME}"
[[ -f "$_kanna_home/.zshenv" ]] && source "$_kanna_home/.zshenv"
"#;

    let zprofile = r#"# Kanna terminal — proxy to user's .zprofile
_kanna_home="${KANNA_ORIG_ZDOTDIR:-$HOME}"
[[ -f "$_kanna_home/.zprofile" ]] && source "$_kanna_home/.zprofile"
"#;

    let zshrc = r#"# Kanna terminal defaults — user's .zshrc runs after and can override
bindkey -e  # emacs keybindings (prevents vi-mode Escape toggling)

# Restore ZDOTDIR and source user's .zshrc
_kanna_home="${KANNA_ORIG_ZDOTDIR:-$HOME}"
ZDOTDIR="$_kanna_home"
[[ -f "$_kanna_home/.zshrc" ]] && source "$_kanna_home/.zshrc"
unset _kanna_home
"#;

    let zlogin = r#"# Kanna terminal — proxy to user's .zlogin
_kanna_home="${KANNA_ORIG_ZDOTDIR:-$HOME}"
[[ -f "$_kanna_home/.zlogin" ]] && source "$_kanna_home/.zlogin"
unset _kanna_home KANNA_ORIG_ZDOTDIR
"#;

    for (name, content) in [
        (".zshenv", zshenv),
        (".zprofile", zprofile),
        (".zshrc", zshrc),
        (".zlogin", zlogin),
    ] {
        std::fs::write(dir.join(name), content)
            .map_err(|e| format!("failed to write {name}: {e}"))?;
    }

    dir.to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "non-UTF-8 path".to_string())
}

#[tauri::command]
pub async fn run_script(
    script: String,
    cwd: String,
    env: HashMap<String, String>,
) -> Result<String, String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let output = Command::new(&shell)
        .arg("-l")
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
            output.status, stderr, stdout
        ))
    }
}
