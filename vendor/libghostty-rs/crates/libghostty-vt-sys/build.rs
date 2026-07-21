use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

mod build_support;

/// Pinned ghostty commit. Update this to pull a newer version.
const GHOSTTY_REPO: &str = "https://github.com/jemdiggity/ghostty.git";
const GHOSTTY_COMMIT: &str = "665a03f380204ce1976941d36649963b4da80880";

fn main() {
    // docs.rs has no Zig toolchain. The checked-in bindings in src/bindings.rs
    // are enough for generating documentation, so skip the entire native
    // build when running under docs.rs.
    if env::var("DOCS_RS").is_ok() {
        return;
    }

    println!("cargo:rerun-if-env-changed=LIBGHOSTTY_VT_SYS_NO_VENDOR");
    println!("cargo:rerun-if-env-changed=GHOSTTY_SOURCE_DIR");
    println!("cargo:rerun-if-env-changed=TARGET");
    println!("cargo:rerun-if-env-changed=HOST");
    println!("cargo:rerun-if-env-changed=DEBUG");
    println!("cargo:rerun-if-env-changed=OPT_LEVEL");
    println!("cargo:rerun-if-env-changed=PROFILE");
    println!("cargo:rerun-if-changed=build.rs");

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR must be set"));
    let target = env::var("TARGET").expect("TARGET must be set");
    let host = env::var("HOST").expect("HOST must be set");

    // Locate ghostty source: env override > fetch into OUT_DIR.
    let ghostty_dir = match env::var("GHOSTTY_SOURCE_DIR") {
        Ok(dir) => {
            let p = PathBuf::from(dir);
            assert!(
                p.join("build.zig").exists(),
                "GHOSTTY_SOURCE_DIR does not contain build.zig: {}",
                p.display()
            );
            p
        }
        Err(_) => fetch_ghostty(&out_dir),
    };

    // Build libghostty-vt via zig.
    let install_prefix = out_dir.join("ghostty-install");

    let mut build = Command::new("zig");
    build
        .arg("build")
        .arg("-Demit-lib-vt")
        .arg(format!("-Doptimize={}", zig_optimize_mode()))
        .arg("--prefix")
        .arg(&install_prefix)
        .current_dir(&ghostty_dir);

    // Only pass -Dtarget when cross-compiling. For native builds, let zig
    // auto-detect the host (matches how ghostty's own CMakeLists.txt works).
    if target != host {
        let zig_target = zig_target(&target);
        build.arg(format!("-Dtarget={zig_target}"));
    }

    run(build, "zig build");

    let lib_dir = install_prefix.join("lib");
    let include_dir = install_prefix.join("include");

    let lib_name = if target.contains("windows") {
        "ghostty-vt-static.lib"
    } else {
        "libghostty-vt.a"
    };

    assert!(
        lib_dir.join(lib_name).exists(),
        "expected static library at {}",
        lib_dir.join(lib_name).display()
    );
    assert!(
        include_dir.join("ghostty").join("vt.h").exists(),
        "expected header at {}",
        include_dir.join("ghostty").join("vt.h").display()
    );

    println!("cargo:rustc-link-search=native={}", lib_dir.display());
    println!("cargo:rustc-link-lib=static=ghostty-vt");
    for companion in find_companion_static_libs(&ghostty_dir) {
        if let Some(parent) = companion.parent() {
            println!("cargo:rustc-link-search=native={}", parent.display());
        }
        if let Some(name) = static_lib_stem(&companion) {
            println!("cargo:rustc-link-lib=static={name}");
        }
    }
    if target.contains("darwin") {
        println!("cargo:rustc-link-lib=c++");
    } else if target.contains("linux") {
        // Zig builds Ghostty's C++ companion libraries against libc++
        // (std::__1 symbols), so Linux consumers must link libc++/libc++abi.
        println!("cargo:rustc-link-lib=c++");
        println!("cargo:rustc-link-lib=c++abi");
    }
    build_support::remove_unused_dynamic_library_symlinks(&out_dir)
        .expect("failed to remove unused libghostty dynamic-library aliases");
    println!("cargo:include={}", include_dir.display());
}

fn zig_optimize_mode() -> &'static str {
    if env::var("DEBUG")
        .ok()
        .is_some_and(|value| value.eq_ignore_ascii_case("true"))
    {
        return "Debug";
    }

    match env::var("OPT_LEVEL").as_deref() {
        Ok("0") => "Debug",
        Ok(_) => "ReleaseFast",
        Err(_) => "ReleaseFast",
    }
}

fn find_companion_static_libs(ghostty_dir: &Path) -> Vec<PathBuf> {
    let cache_dir = ghostty_dir.join(".zig-cache");
    let wanted = ["libsimdutf.a", "libhighway.a", "libutfcpp.a"];
    let mut found = Vec::new();
    for name in wanted {
        if let Some(path) = find_file_recursive(&cache_dir, name) {
            found.push(path);
        }
    }
    found
}

fn find_file_recursive(root: &Path, needle: &str) -> Option<PathBuf> {
    let entries = fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_file_recursive(&path, needle) {
                return Some(found);
            }
        } else if path.file_name().and_then(|v| v.to_str()) == Some(needle) {
            return Some(path);
        }
    }
    None
}

fn static_lib_stem(path: &Path) -> Option<String> {
    let file_name = path.file_name()?.to_str()?;
    let stem = file_name
        .strip_prefix("lib")
        .unwrap_or(file_name)
        .strip_suffix(".a")
        .unwrap_or(file_name);
    Some(stem.to_string())
}

/// Clone ghostty at the pinned commit into OUT_DIR/ghostty-src.
/// Reuses an existing clone if the commit matches.
fn fetch_ghostty(out_dir: &Path) -> PathBuf {
    let src_dir = out_dir.join("ghostty-src");
    let stamp = src_dir.join(".ghostty-commit");

    // Skip fetch if we already have the right commit.
    if stamp.exists()
        && let Ok(existing) = std::fs::read_to_string(&stamp)
        && existing.trim() == GHOSTTY_COMMIT
    {
        return src_dir;
    }

    // Clean and clone fresh.
    if src_dir.exists() {
        std::fs::remove_dir_all(&src_dir)
            .unwrap_or_else(|e| panic!("failed to remove {}: {e}", src_dir.display()));
    }

    eprintln!("Fetching ghostty {GHOSTTY_COMMIT} ...");

    let mut clone = Command::new("git");
    clone
        .arg("clone")
        .arg("--filter=blob:none")
        .arg("--no-checkout")
        .arg(GHOSTTY_REPO)
        .arg(&src_dir);
    run(clone, "git clone ghostty");

    let mut checkout = Command::new("git");
    checkout
        .arg("checkout")
        .arg(GHOSTTY_COMMIT)
        .current_dir(&src_dir);
    run(checkout, "git checkout ghostty commit");

    std::fs::write(&stamp, GHOSTTY_COMMIT).unwrap_or_else(|e| panic!("failed to write stamp: {e}"));

    src_dir
}

fn run(mut command: Command, context: &str) {
    let status = command
        .status()
        .unwrap_or_else(|error| panic!("failed to execute {context}: {error}"));
    assert!(status.success(), "{context} failed with status {status}");
}

fn zig_target(target: &str) -> String {
    let value = match target {
        "x86_64-unknown-linux-gnu" => "x86_64-linux-gnu",
        "x86_64-unknown-linux-musl" => "x86_64-linux-musl",
        "aarch64-unknown-linux-gnu" => "aarch64-linux-gnu",
        "aarch64-unknown-linux-musl" => "aarch64-linux-musl",
        "aarch64-apple-darwin" => "aarch64-macos-none",
        "x86_64-apple-darwin" => "x86_64-macos-none",
        other => panic!("unsupported Rust target for vendored build: {other}"),
    };
    value.to_owned()
}
