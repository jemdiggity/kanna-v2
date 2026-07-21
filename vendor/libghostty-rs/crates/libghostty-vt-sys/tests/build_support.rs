#[path = "../build_support.rs"]
mod build_support;

use std::fs;
use std::os::unix::fs::symlink;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_root() -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before Unix epoch")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "libghostty-build-support-{}-{nonce}",
        std::process::id()
    ))
}

#[test]
fn removes_only_generated_dynamic_library_aliases() {
    let root = temp_root();
    let lib_dir = root.join("nested/lib");
    fs::create_dir_all(&lib_dir).unwrap();

    fs::write(
        lib_dir.join("libghostty-vt.0.1.0.dylib"),
        b"dynamic library",
    )
    .unwrap();
    symlink(
        "libghostty-vt.0.1.0.dylib",
        lib_dir.join("libghostty-vt.0.dylib"),
    )
    .unwrap();
    symlink("libghostty-vt.0.dylib", lib_dir.join("libghostty-vt.dylib")).unwrap();
    symlink("libghostty-vt.a", lib_dir.join("unrelated-link")).unwrap();

    let removed = build_support::remove_unused_dynamic_library_symlinks(&root).unwrap();

    assert_eq!(removed.len(), 2);
    assert!(!lib_dir.join("libghostty-vt.0.dylib").exists());
    assert!(!lib_dir.join("libghostty-vt.dylib").exists());
    assert!(lib_dir.join("libghostty-vt.0.1.0.dylib").is_file());
    assert!(
        fs::symlink_metadata(lib_dir.join("unrelated-link"))
            .unwrap()
            .file_type()
            .is_symlink()
    );

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn build_script_tracks_cleanup_helper() {
    assert!(
        include_str!("../build.rs").contains("cargo:rerun-if-changed=build_support.rs"),
        "build_support.rs changes must rerun the vendored Ghostty build"
    );
}
