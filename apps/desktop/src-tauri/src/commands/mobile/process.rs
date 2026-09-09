use std::path::PathBuf;

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

#[cfg(test)]
mod tests {
    use super::*;

    /// `find_sidecar` is the only thing left here; the port-owner helpers this
    /// module used to hold now live in `kanna-server-process`, because
    /// `kanna-worker` needs exactly the same answers and a second copy would
    /// drift.
    #[test]
    fn find_sidecar_reports_the_name_it_could_not_resolve() {
        let error = find_sidecar("kanna-not-a-sidecar").expect_err("no such sidecar");
        assert!(error.contains("kanna-not-a-sidecar"), "{error}");
    }
}
