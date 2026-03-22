fn main() {
    // Embed VERSION file content so lib.rs can use it for the About dialog
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap();
    let version_file = root.join("VERSION");
    if version_file.exists() {
        let version = std::fs::read_to_string(&version_file)
            .unwrap_or_default()
            .trim()
            .to_string();
        println!("cargo:rustc-env=KANNA_VERSION={}", version);
    } else {
        println!("cargo:rustc-env=KANNA_VERSION=unknown");
    }
    println!("cargo:rerun-if-changed={}", version_file.display());

    tauri_build::build()
}
