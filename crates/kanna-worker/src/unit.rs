//! The `systemd --user` unit that starts this supervisor.
//!
//! The unit exists to give the worker a *lifetime*, not a trust root: the
//! trust root is the supervisor's own executable, which is why the daemon is
//! parented by it rather than by `systemd --user` (see the crate docs).
//!
//! Two settings are load-bearing:
//!
//! * **`KillMode=process`.** Without it, stopping or restarting the unit kills
//!   the whole control group -- which is the daemon and every agent session on
//!   the machine. Sessions surviving their supervisor is the daemon's reason
//!   to exist, so systemd must stop only the supervisor. A fresh supervisor
//!   re-pins the surviving daemon through adoption, exactly as a relaunched
//!   desktop app does.
//! * **An explicit `PATH`.** A user unit inherits almost nothing, and the
//!   toolchains agent CLIs need (cargo, node, and the CLIs themselves) are
//!   typically added by an interactive shell's startup files, which never run
//!   here.
//!
//! Surviving logout additionally needs `loginctl enable-linger <user>`, which
//! keeps `user@<uid>.service` alive with no session. That is the
//! administrator's call, so `install-unit` reports it rather than doing it.

use crate::config::Options;
use std::path::PathBuf;

pub fn print(args: &[String]) -> Result<(), String> {
    let options = Options::parse(args)?;
    print!("{}", render(&options)?);
    Ok(())
}

pub fn install(args: &[String]) -> Result<(), String> {
    let options = Options::parse(args)?;
    let path = match options.unit_path.clone() {
        Some(path) => path,
        None => default_unit_path()?,
    };
    let parent = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    std::fs::write(&path, render(&options)?)
        .map_err(|error| format!("failed to write {}: {error}", path.display()))?;

    println!("wrote {}", path.display());
    println!("next:");
    println!("  systemctl --user daemon-reload");
    println!("  systemctl --user enable --now kanna-worker.service");
    println!("  loginctl enable-linger $USER   # to survive logout");
    Ok(())
}

fn default_unit_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| {
            "HOME is not set, so the user unit directory cannot be resolved".to_string()
        })?;
    let config_home = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| home.join(".config"));
    Ok(config_home
        .join("systemd")
        .join("user")
        .join("kanna-worker.service"))
}

pub fn render(options: &Options) -> Result<String, String> {
    let exe = std::env::current_exe()
        .map_err(|error| format!("cannot resolve own path: {error}"))?
        .to_string_lossy()
        .into_owned();
    Ok(render_with(
        &exe,
        &options.data_dir.to_string_lossy(),
        options.lan_port(),
        options.transfer_port(),
        &std::env::var("PATH").unwrap_or_else(|_| "/usr/local/bin:/usr/bin:/bin".to_string()),
    ))
}

fn render_with(
    executable: &str,
    data_dir: &str,
    lan_port: u16,
    transfer_port: u16,
    path: &str,
) -> String {
    format!(
        "[Unit]\n\
         Description=Kanna headless worker\n\
         Documentation=https://github.com/tampopogk/kanna\n\
         After=default.target\n\
         \n\
         [Service]\n\
         Type=simple\n\
         ExecStart={executable} run --data-dir {data_dir} --lan-port {lan_port} --transfer-port {transfer_port}\n\
         ExecReload=/bin/kill -HUP $MAINPID\n\
         Restart=on-failure\n\
         RestartSec=2\n\
         # Stop only the supervisor. The daemon and every agent session it owns\n\
         # live in this control group and must survive a unit restart, exactly as\n\
         # they survive closing the desktop app.\n\
         KillMode=process\n\
         Environment=PATH={path}\n\
         \n\
         [Install]\n\
         WantedBy=default.target\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_unit_stops_only_the_supervisor_and_carries_an_explicit_path() {
        let unit = render_with(
            "/opt/kanna/bin/kanna-worker",
            "/home/tester/.local/share/Kanna",
            48120,
            48130,
            "/opt/toolchain/bin:/usr/bin",
        );

        assert!(
            unit.contains("KillMode=process\n"),
            "a unit that kills its control group takes every agent session with it: {unit}"
        );
        assert!(unit.contains("Environment=PATH=/opt/toolchain/bin:/usr/bin\n"));
        assert!(unit.contains(
            "ExecStart=/opt/kanna/bin/kanna-worker run --data-dir /home/tester/.local/share/Kanna \
             --lan-port 48120 --transfer-port 48130\n"
        ));
        assert!(unit.contains("ExecReload=/bin/kill -HUP $MAINPID\n"));
        assert!(unit.contains("WantedBy=default.target\n"));
    }

    #[test]
    fn the_unit_path_follows_xdg_config_home() {
        // Serialised by construction: this test owns both variables and
        // restores them, and no other test in this crate reads them.
        let previous_home = std::env::var_os("HOME");
        let previous_config = std::env::var_os("XDG_CONFIG_HOME");

        std::env::set_var("HOME", "/home/tester");
        std::env::remove_var("XDG_CONFIG_HOME");
        assert_eq!(
            default_unit_path().unwrap(),
            PathBuf::from("/home/tester/.config/systemd/user/kanna-worker.service")
        );

        std::env::set_var("XDG_CONFIG_HOME", "/xdg/config");
        assert_eq!(
            default_unit_path().unwrap(),
            PathBuf::from("/xdg/config/systemd/user/kanna-worker.service")
        );

        // A relative value is invalid per the spec and must be ignored.
        std::env::set_var("XDG_CONFIG_HOME", "relative");
        assert_eq!(
            default_unit_path().unwrap(),
            PathBuf::from("/home/tester/.config/systemd/user/kanna-worker.service")
        );

        match previous_home {
            Some(value) => std::env::set_var("HOME", value),
            None => std::env::remove_var("HOME"),
        }
        match previous_config {
            Some(value) => std::env::set_var("XDG_CONFIG_HOME", value),
            None => std::env::remove_var("XDG_CONFIG_HOME"),
        }
    }
}
