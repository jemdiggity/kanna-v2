use std::collections::HashMap;

const STRIPPED_ENV_PREFIXES: &[&str] = &["KANNA_"];
// Claude-session identity markers: when Kanna itself was launched from inside
// a Claude Code session, these leak into the daemon and every agent CLI it
// spawns. A spawned `claude` then believes it is a nested child session and
// disables transcript persistence — which silently breaks revision resume and
// task transfer, both of which depend on the transcript existing. Kanna agent
// sessions are top-level by definition, so the markers are stripped. This is
// an explicit list, not a `CLAUDE_` prefix: intentional user configuration
// such as CLAUDE_CONFIG_DIR must pass through.
const STRIPPED_ENV_VARS: &[&str] = &[
    "TAURI_WEBDRIVER_PORT",
    "NO_COLOR",
    "CLAUDECODE",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_PID",
];

fn should_strip_inherited_env_var(key: &str) -> bool {
    STRIPPED_ENV_PREFIXES
        .iter()
        .any(|prefix| key.starts_with(prefix))
        || STRIPPED_ENV_VARS.contains(&key)
}

fn build_child_env_from_iter<I, J>(parent: I, explicit: J) -> HashMap<String, String>
where
    I: IntoIterator<Item = (String, String)>,
    J: IntoIterator<Item = (String, String)>,
{
    let mut env = HashMap::new();

    for (key, value) in parent {
        if should_strip_inherited_env_var(&key) {
            continue;
        }
        env.insert(key, value);
    }

    for (key, value) in explicit {
        env.insert(key, value);
    }

    env
}

pub fn build_child_env<J>(explicit: J) -> HashMap<String, String>
where
    J: IntoIterator<Item = (String, String)>,
{
    build_child_env_from_iter(std::env::vars(), explicit)
}

pub fn apply_child_env<J>(command: &mut tokio::process::Command, explicit: J)
where
    J: IntoIterator<Item = (String, String)>,
{
    command.env_clear().envs(build_child_env(explicit));
}

pub fn inherited_env_keys_to_strip() -> Vec<String> {
    std::env::vars()
        .map(|(key, _)| key)
        .filter(|key| should_strip_inherited_env_var(key))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::build_child_env_from_iter;
    use std::collections::HashMap;

    #[test]
    fn strips_inherited_kanna_and_webdriver_env() {
        let env = build_child_env_from_iter(
            [
                ("PATH".to_string(), "/usr/bin:/bin".to_string()),
                ("HOME".to_string(), "/Users/test".to_string()),
                ("KANNA_DB_PATH".to_string(), "/tmp/leaked.db".to_string()),
                (
                    "KANNA_TMUX_SESSION".to_string(),
                    "leaked-session".to_string(),
                ),
                ("TAURI_WEBDRIVER_PORT".to_string(), "4555".to_string()),
            ],
            HashMap::<String, String>::new(),
        );

        assert_eq!(env.get("PATH"), Some(&"/usr/bin:/bin".to_string()));
        assert_eq!(env.get("HOME"), Some(&"/Users/test".to_string()));
        assert!(!env.contains_key("KANNA_DB_PATH"));
        assert!(!env.contains_key("KANNA_TMUX_SESSION"));
        assert!(!env.contains_key("TAURI_WEBDRIVER_PORT"));
    }

    #[test]
    fn strips_inherited_claude_session_markers_but_keeps_user_config() {
        let env = build_child_env_from_iter(
            [
                ("PATH".to_string(), "/usr/bin:/bin".to_string()),
                ("CLAUDECODE".to_string(), "1".to_string()),
                ("CLAUDE_CODE_CHILD_SESSION".to_string(), "1".to_string()),
                (
                    "CLAUDE_CODE_SESSION_ID".to_string(),
                    "4eb73497-1c57-4e60-b0eb-dd9db12f8dbe".to_string(),
                ),
                ("CLAUDE_CODE_ENTRYPOINT".to_string(), "cli".to_string()),
                ("CLAUDE_CODE_EXECPATH".to_string(), "/x/claude".to_string()),
                ("CLAUDE_PID".to_string(), "41455".to_string()),
                (
                    "CLAUDE_CONFIG_DIR".to_string(),
                    "/Users/test/.claude".to_string(),
                ),
            ],
            HashMap::<String, String>::new(),
        );

        assert!(!env.contains_key("CLAUDECODE"));
        assert!(!env.contains_key("CLAUDE_CODE_CHILD_SESSION"));
        assert!(!env.contains_key("CLAUDE_CODE_SESSION_ID"));
        assert!(!env.contains_key("CLAUDE_CODE_ENTRYPOINT"));
        assert!(!env.contains_key("CLAUDE_CODE_EXECPATH"));
        assert!(!env.contains_key("CLAUDE_PID"));
        assert_eq!(
            env.get("CLAUDE_CONFIG_DIR"),
            Some(&"/Users/test/.claude".to_string())
        );
    }

    #[test]
    fn strips_inherited_no_color_env() {
        let env = build_child_env_from_iter(
            [
                ("PATH".to_string(), "/usr/bin:/bin".to_string()),
                ("NO_COLOR".to_string(), "1".to_string()),
            ],
            [
                ("TERM".to_string(), "xterm-256color".to_string()),
                ("COLORTERM".to_string(), "truecolor".to_string()),
            ],
        );

        assert_eq!(env.get("TERM"), Some(&"xterm-256color".to_string()));
        assert_eq!(env.get("COLORTERM"), Some(&"truecolor".to_string()));
        assert!(!env.contains_key("NO_COLOR"));
    }

    #[test]
    fn preserves_explicit_kanna_env_after_parent_scrub() {
        let env = build_child_env_from_iter(
            [
                ("KANNA_WORKTREE".to_string(), "0".to_string()),
                ("PATH".to_string(), "/usr/bin:/bin".to_string()),
            ],
            [("KANNA_WORKTREE".to_string(), "1".to_string())],
        );

        assert_eq!(env.get("KANNA_WORKTREE"), Some(&"1".to_string()));
        assert_eq!(env.get("PATH"), Some(&"/usr/bin:/bin".to_string()));
    }
}
