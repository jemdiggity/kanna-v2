use std::process::Command;

fn git(args: &[&str]) -> String {
    Command::new("git")
        .args(args)
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

fn main() {
    let commit = git(&["rev-parse", "--short", "HEAD"]);
    let branch = git(&["rev-parse", "--abbrev-ref", "HEAD"]);

    // Version from latest git tag (strip leading 'v'), fallback to 0.0.0
    let tag = git(&["describe", "--tags", "--abbrev=0"]);
    let version = if tag == "unknown" || tag.is_empty() {
        "0.0.0".to_string()
    } else {
        tag.strip_prefix('v').unwrap_or(&tag).to_string()
    };

    println!("cargo:rustc-env=KANNA_VERSION={}", version);
    println!("cargo:rustc-env=GIT_COMMIT={}", commit);
    println!("cargo:rustc-env=GIT_BRANCH={}", branch);
}
