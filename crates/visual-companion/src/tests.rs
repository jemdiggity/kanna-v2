use super::*;
use kanna_agent_protocol::{CompanionDocumentKind, CompanionEvent};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

struct Fixture {
    worktree: PathBuf,
    temp_dir: tempfile::TempDir,
}

#[test]
fn materialization_budget_admits_bytes_before_work_and_reclaims_on_drop() {
    let budget = Arc::new(CompanionMaterializationBudget::new(2, 100));
    let first = budget.try_reserve(60).expect("first scan admitted");
    assert!(budget.try_reserve(50).is_none());
    assert_eq!(budget.retained_bytes(), 60);
    drop(first);
    let second = budget.try_reserve(50).expect("bytes reclaimed");
    let third = budget
        .try_reserve(50)
        .expect("second concurrent scan admitted");
    assert!(budget.try_reserve(1).is_none());
    drop((second, third));
    assert_eq!(budget.retained_bytes(), 0);
}

impl Fixture {
    fn new() -> Self {
        let temp_dir = tempfile::tempdir().expect("create companion fixture");
        let worktree = temp_dir.path().join("worktree");
        std::fs::create_dir_all(&worktree).expect("create fixture worktree");
        Self { worktree, temp_dir }
    }

    fn worktree(&self) -> &Path {
        &self.worktree
    }

    fn session_path(&self, session_id: &str) -> PathBuf {
        self.worktree
            .join(".superpowers/brainstorm")
            .join(session_id)
    }

    fn write(&self, relative: impl AsRef<Path>, bytes: impl AsRef<[u8]>) -> PathBuf {
        let target = self.worktree.join(relative);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).expect("create fixture parent");
        }
        std::fs::write(&target, bytes).expect("write fixture file");
        target
    }

    fn active_session(&self, session_id: &str, file_name: &str, html: impl AsRef<[u8]>) -> PathBuf {
        self.write(
            format!(".superpowers/brainstorm/{session_id}/state/server-info"),
            b"{}",
        );
        self.write(
            format!(".superpowers/brainstorm/{session_id}/content/{file_name}"),
            html,
        )
    }

    fn server_info(&self, session_id: &str, json: impl AsRef<[u8]>) -> PathBuf {
        self.write(
            format!(".superpowers/brainstorm/{session_id}/state/server-info"),
            json,
        )
    }

    fn content(&self, session_id: &str, file_name: &str, bytes: impl AsRef<[u8]>) -> PathBuf {
        self.write(
            format!(".superpowers/brainstorm/{session_id}/content/{file_name}"),
            bytes,
        )
    }

    fn event() -> CompanionEvent {
        CompanionEvent {
            session_id: "123-456".into(),
            revision: "revision-1".into(),
            event_id: "event-1".into(),
            event_type: "click".into(),
            choice: "a".into(),
            text: "Option A".into(),
            element_id: None,
            timestamp: 1_784_268_000_000,
        }
    }

    fn event_for(document: &CompanionBundle) -> CompanionEvent {
        CompanionEvent {
            session_id: document.session_id.clone(),
            revision: document.revision.clone(),
            ..Self::event()
        }
    }
}

#[test]
fn discovers_current_document_from_explicit_workspace() {
    let fixture = Fixture::new();
    fixture.active_session("session-a", "screen.html", "<h2>A</h2>");
    let document = current_bundle(fixture.worktree()).unwrap().unwrap();
    assert_eq!(document.session_id, "session-a");
    assert_eq!(document.html, "<h2>A</h2>");
    assert_eq!(document.document_kind, CompanionDocumentKind::Fragment);
}

#[test]
fn prepares_sibling_and_files_image_sources_as_bounded_data_uris() {
    let fixture = Fixture::new();
    fixture.active_session(
        "session-a",
        "screen.html",
        r#"<img id="relative" src="01.png"><img id="files" src="/files/02.jpg">"#,
    );
    fixture.content("session-a", "01.png", b"PNG");
    fixture.content("session-a", "02.jpg", b"JPEG");

    let mut scanner = CompanionScanner::new();
    let CompanionScan::Changed(Some(bundle)) =
        scanner.scan_with_assets(fixture.worktree(), false).unwrap()
    else {
        panic!("expected prepared companion");
    };

    assert!(bundle
        .html
        .contains(r#"id="relative" src="data:image/png;base64,UE5H""#));
    assert!(bundle
        .html
        .contains(r#"id="files" src="data:image/jpeg;base64,SlBFRw==""#));
    assert!(bundle.assets.is_empty());
}

#[test]
fn local_image_preparation_rejects_out_of_tree_and_hostile_sources_visibly() {
    let fixture = Fixture::new();
    fixture.active_session(
        "session-a",
        "screen.html",
        concat!(
            r#"<img src="../secret.png">"#,
            r#"<img src="/tmp/secret.png">"#,
            r#"<img src="javascript:alert(1)">"#,
        ),
    );
    fixture.write("secret.png", b"outside");

    let bundle = current_bundle(fixture.worktree()).unwrap().unwrap();

    assert!(!bundle.html.contains("data:image"));
    assert!(bundle
        .html
        .contains("Image unavailable: ../secret.png (path is outside companion content)."));
    assert!(bundle
        .html
        .contains("Image unavailable: /tmp/secret.png (path is outside companion content)."));
    assert!(bundle.html.contains(
        "Image unavailable: javascript:alert(1) (file type is not a supported passive image)."
    ));
    assert!(!bundle.html.contains("b3V0c2lkZQ=="));
}

#[test]
fn local_image_preparation_degrades_oversized_references_visibly() {
    let fixture = Fixture::new();
    fixture.active_session("session-a", "screen.html", r#"<img src="gallery.png">"#);
    fixture.content(
        "session-a",
        "gallery.png",
        vec![b'x'; MAX_COMPANION_INLINE_IMAGE_TOTAL_BYTES as usize + 1],
    );

    let bundle = current_bundle(fixture.worktree()).unwrap().unwrap();

    assert!(!bundle.html.contains("data:image"));
    assert!(bundle
        .html
        .contains("Image unavailable: gallery.png (768 KiB document image budget is exhausted)."));
}

#[cfg(unix)]
#[test]
fn local_image_preparation_never_follows_sibling_symlinks() {
    let fixture = Fixture::new();
    fixture.active_session("session-a", "screen.html", r#"<img src="linked.png">"#);
    let outside = fixture.write("outside.png", b"outside");
    std::os::unix::fs::symlink(
        outside,
        fixture.session_path("session-a").join("content/linked.png"),
    )
    .unwrap();

    let bundle = current_bundle(fixture.worktree()).unwrap().unwrap();

    assert!(!bundle.html.contains("data:image"));
    assert!(bundle
        .html
        .contains("Image unavailable: linked.png (file is unavailable or unsafe)."));
}

#[test]
fn returns_none_without_a_brainstorm_directory() {
    let fixture = Fixture::new();
    assert_eq!(current_bundle(fixture.worktree()).unwrap(), None);
}

#[test]
fn reads_an_active_fragment_and_computes_a_stable_revision() {
    let fixture = Fixture::new();
    fixture.active_session("123-456", "layout.html", b"<h2>Choose</h2>");

    let first = current_bundle(fixture.worktree()).unwrap().unwrap();
    let second = current_bundle(fixture.worktree()).unwrap().unwrap();
    assert_eq!(first.session_id, "123-456");
    assert_eq!(first.html, "<h2>Choose</h2>");
    assert_eq!(first.document_kind, CompanionDocumentKind::Fragment);
    assert_eq!(first.revision, second.revision);
}

#[test]
fn detects_a_complete_html_document() {
    let fixture = Fixture::new();
    fixture.active_session(
        "123-456",
        "layout.html",
        b"  <!DOCTYPE html><html><body>Choose</body></html>",
    );
    let document = current_bundle(fixture.worktree()).unwrap().unwrap();
    assert_eq!(document.document_kind, CompanionDocumentKind::FullDocument);
}

#[test]
fn chooses_the_newest_html_in_the_newest_active_session() {
    let fixture = Fixture::new();
    fixture.active_session("older", "first.html", b"older session");
    std::thread::sleep(Duration::from_millis(15));
    fixture.active_session("newer", "first.html", b"first screen");
    std::thread::sleep(Duration::from_millis(15));
    fixture.active_session("newer", "second.html", b"newest screen");

    let document = current_bundle(fixture.worktree()).unwrap().unwrap();
    assert_eq!(document.session_id, "newer");
    assert_eq!(document.html, "newest screen");
}

#[test]
fn ignores_stopped_or_incompletely_started_sessions() {
    let fixture = Fixture::new();
    fixture.active_session("stopped", "layout.html", b"stopped");
    fixture.write(
        ".superpowers/brainstorm/stopped/state/server-stopped",
        b"{}",
    );
    fixture.write(
        ".superpowers/brainstorm/missing-info/content/layout.html",
        b"not active",
    );
    assert_eq!(current_bundle(fixture.worktree()).unwrap(), None);
}

#[test]
fn rejects_invalid_or_oversized_html() {
    let fixture = Fixture::new();
    fixture.active_session("invalid", "layout.html", [0xff, 0xfe]);
    assert_eq!(
        current_bundle(fixture.worktree()),
        Err(CompanionError::UnsupportedContent)
    );

    fixture.write(
        ".superpowers/brainstorm/invalid/state/server-stopped",
        b"{}",
    );
    fixture.active_session(
        "large",
        "layout.html",
        vec![b'x'; MAX_COMPANION_HTML_BYTES as usize + 1],
    );
    assert_eq!(
        current_bundle(fixture.worktree()),
        Err(CompanionError::TooLarge)
    );
}

#[test]
fn reports_unavailable_workspace_paths() {
    let fixture = Fixture::new();
    assert_eq!(
        current_bundle(&fixture.temp_dir.path().join("missing")),
        Err(CompanionError::WorkspaceUnavailable)
    );
    assert_eq!(
        current_bundle(Path::new("relative-workspace")),
        Err(CompanionError::WorkspaceUnavailable)
    );
}

#[cfg(unix)]
#[test]
fn never_follows_content_or_session_symlinks() {
    let fixture = Fixture::new();
    let outside_session = fixture.temp_dir.path().join("outside-session");
    std::fs::create_dir_all(outside_session.join("content")).unwrap();
    std::fs::create_dir_all(outside_session.join("state")).unwrap();
    std::fs::write(outside_session.join("content/secret.html"), "secret").unwrap();
    std::fs::write(outside_session.join("state/server-info"), "{}").unwrap();
    std::fs::create_dir_all(fixture.worktree.join(".superpowers/brainstorm")).unwrap();
    std::os::unix::fs::symlink(
        &outside_session,
        fixture
            .worktree
            .join(".superpowers/brainstorm/linked-session"),
    )
    .unwrap();

    fixture.write(
        ".superpowers/brainstorm/linked-content/state/server-info",
        b"{}",
    );
    std::fs::create_dir_all(fixture.session_path("linked-content").join("content")).unwrap();
    std::os::unix::fs::symlink(
        outside_session.join("content/secret.html"),
        fixture
            .session_path("linked-content")
            .join("content/layout.html"),
    )
    .unwrap();

    assert_eq!(current_bundle(fixture.worktree()).unwrap(), None);
}

#[cfg(unix)]
#[test]
fn never_reads_hardlinked_companion_documents() {
    let fixture = Fixture::new();
    fixture.active_session("hardlinked-document", "layout.html", b"placeholder");
    let outside = fixture.temp_dir.path().join("outside-document");
    std::fs::write(&outside, b"same-user secret").unwrap();
    let document = fixture
        .session_path("hardlinked-document")
        .join("content/layout.html");
    std::fs::remove_file(&document).unwrap();
    std::fs::hard_link(&outside, &document).unwrap();

    assert_eq!(current_bundle(fixture.worktree()).unwrap(), None);
}

#[cfg(unix)]
#[test]
fn omits_hardlinked_companion_metadata_and_assets() {
    let fixture = Fixture::new();
    fixture.active_session("hardlinked-read-sources", "layout.html", b"<h1>Safe</h1>");
    let outside_info = fixture.temp_dir.path().join("outside-server-info");
    let outside_asset = fixture.temp_dir.path().join("outside-asset");
    std::fs::write(&outside_info, br#"{"url":"http://localhost:52341"}"#).unwrap();
    std::fs::write(&outside_asset, b"same-user asset secret").unwrap();
    let state = fixture
        .session_path("hardlinked-read-sources")
        .join("state");
    let content = fixture
        .session_path("hardlinked-read-sources")
        .join("content");
    std::fs::remove_file(state.join("server-info")).unwrap();
    std::fs::hard_link(&outside_info, state.join("server-info")).unwrap();
    std::fs::hard_link(&outside_asset, content.join("layout.png")).unwrap();

    let bundle = current_bundle(fixture.worktree()).unwrap().unwrap();
    assert_eq!(bundle.html, "<h1>Safe</h1>");
    assert_eq!(bundle.source_origin, None);
    assert!(bundle.assets.is_empty());
}

#[test]
fn follows_an_explicit_workspace_path_replacement_not_the_old_directory() {
    let fixture = Fixture::new();
    fixture.active_session("old", "layout.html", b"old companion");
    let departed = fixture.temp_dir.path().join("departed");
    std::fs::rename(fixture.worktree(), &departed).unwrap();
    std::fs::create_dir_all(fixture.worktree()).unwrap();

    assert_eq!(current_bundle(fixture.worktree()).unwrap(), None);
}

#[test]
fn origin_metadata_accepts_only_normalized_explicit_loopback_http_origins() {
    let cases = [
        ("http://localhost:52341", Some("http://localhost:52341")),
        ("http://127.0.0.1:52341/", Some("http://127.0.0.1:52341")),
        ("http://[::1]:52341", Some("http://[::1]:52341")),
        ("HTTP://LOCALHOST:52341/", Some("http://localhost:52341")),
        ("http://localhost:1", Some("http://localhost:1")),
        ("http://localhost:65535", Some("http://localhost:65535")),
        ("http://localhost:80", Some("http://localhost:80")),
        ("https://localhost:52341", None),
        ("http://example.com:52341", None),
        ("http://user@localhost:52341", None),
        ("http://localhost:52341?query=yes", None),
        ("http://localhost", None),
        ("http://localhost:0", None),
        ("http://localhost:65536", None),
        ("http://localhost:52341#fragment", None),
        ("http://user:password@localhost:52341", None),
        ("http://localhost:52341/screen", None),
        ("http://127.1:52341", None),
        ("http://2130706433:52341", None),
        ("http://localhost:52341/foo/..", None),
        ("http://localhost:52341/.", None),
        ("http://@localhost:52341", None),
        ("http://:@localhost:52341", None),
        ("http://127.0.0.01:52341", None),
        ("http://0x7f000001:52341", None),
        ("http://0177.0.0.1:52341", None),
        ("http://[0:0:0:0:0:0:0:1]:52341", None),
        ("http://localhost:+52341", None),
        ("http://localhost: 52341", None),
        ("http://localhost:52341:80", None),
        ("http://localhost:52341//", None),
    ];

    for (index, (url, expected)) in cases.into_iter().enumerate() {
        let fixture = Fixture::new();
        let session_id = format!("origin-{index}");
        fixture.active_session(&session_id, "screen.html", "<h1>Screen</h1>");
        fixture.server_info(&session_id, format!(r#"{{"url":"{url}"}}"#));

        let bundle = current_bundle(fixture.worktree()).unwrap().unwrap();
        assert_eq!(
            bundle.source_origin.as_deref(),
            expected,
            "unexpected origin result for {url}"
        );
        assert_eq!(bundle.html, "<h1>Screen</h1>");
    }
}

#[test]
fn released_server_info_suffixes_expose_only_the_source_origin() {
    for (index, url) in [
        "http://localhost:52341/?key=released-secret",
        "http://localhost:52341/#released-fragment",
        "http://localhost:52341/?key=x#released-fragment",
    ]
    .into_iter()
    .enumerate()
    {
        let fixture = Fixture::new();
        let session_id = format!("released-origin-{index}");
        fixture.active_session(&session_id, "screen.html", "<h1>Screen</h1>");
        fixture.server_info(&session_id, format!(r#"{{"url":"{url}"}}"#));

        let bundle = current_bundle(fixture.worktree()).unwrap().unwrap();
        assert_eq!(
            bundle.source_origin.as_deref(),
            Some("http://localhost:52341"),
            "released suffix was not discarded for {url}"
        );
        let source_origin = bundle.source_origin.as_deref().unwrap();
        assert!(!source_origin.contains("released-secret"));
        assert!(!source_origin.contains("released-fragment"));
    }
}

#[test]
fn invalid_origin_metadata_does_not_hide_an_otherwise_valid_document() {
    let cases: Vec<Vec<u8>> = vec![
        b"not json".to_vec(),
        br#"{"other":"field"}"#.to_vec(),
        br#"{"url":17}"#.to_vec(),
        vec![b'x'; 64 * 1024],
    ];

    for (index, metadata) in cases.into_iter().enumerate() {
        let fixture = Fixture::new();
        let session_id = format!("invalid-origin-{index}");
        fixture.active_session(&session_id, "screen.html", "<h1>Screen</h1>");
        fixture.server_info(&session_id, metadata);

        let bundle = current_bundle(fixture.worktree()).unwrap().unwrap();
        assert_eq!(bundle.source_origin, None);
        assert_eq!(bundle.html, "<h1>Screen</h1>");
    }
}

#[cfg(unix)]
#[test]
fn symlinked_origin_metadata_is_not_followed_or_allowed_to_hide_the_document() {
    let fixture = Fixture::new();
    fixture.active_session("origin-link", "screen.html", "<h1>Screen</h1>");
    let outside = fixture.temp_dir.path().join("outside-server-info");
    std::fs::write(&outside, r#"{"url":"http://localhost:52341"}"#).unwrap();
    let server_info = fixture
        .session_path("origin-link")
        .join("state/server-info");
    std::fs::remove_file(&server_info).unwrap();
    std::os::unix::fs::symlink(outside, server_info).unwrap();

    let bundle = current_bundle(fixture.worktree()).unwrap().unwrap();
    assert_eq!(bundle.source_origin, None);
    assert_eq!(bundle.html, "<h1>Screen</h1>");
}

#[test]
fn asset_bundle_includes_direct_file_bytes_mime_and_digest() {
    let fixture = Fixture::new();
    fixture.active_session("assets", "screen.html", "<img src='/files/layout.png'>");
    fixture.content("assets", "layout.png", b"PNG");

    let bundle = current_bundle(fixture.worktree()).unwrap().unwrap();
    assert_eq!(bundle.assets.len(), 1);
    assert_eq!(bundle.assets[0].name, "layout.png");
    assert_eq!(bundle.assets[0].content_type, "image/png");
    assert_eq!(
        bundle.assets[0].digest,
        "796120837694d3f3f29259cfeb25091698c2a0aa87873658d840b4993ee889b3"
    );
    assert_eq!(bundle.assets[0].data_b64, "UE5H");
}

#[test]
fn asset_bundle_excludes_html_screens_and_subdirectory_contents() {
    let fixture = Fixture::new();
    fixture.active_session("assets", "screen.html", "<h1>Screen</h1>");
    fixture.content("assets", "alternate.htm", "<h1>Alternate</h1>");
    fixture.content("assets", "UPPER.HTML", "<h1>Upper</h1>");
    fixture.content("assets", "nested/inside.png", b"nested");
    fixture.content("assets", "direct.css", b"body{}");

    let bundle = current_bundle(fixture.worktree()).unwrap().unwrap();
    assert_eq!(
        bundle
            .assets
            .iter()
            .map(|asset| asset.name.as_str())
            .collect::<Vec<_>>(),
        ["direct.css"]
    );
}

#[cfg(unix)]
#[test]
fn asset_bundle_excludes_symlinks_inside_and_outside_the_workspace() {
    let fixture = Fixture::new();
    fixture.active_session("assets", "screen.html", "<h1>Screen</h1>");
    let regular = fixture.content("assets", "regular.png", b"regular");
    let outside = fixture.temp_dir.path().join("outside.png");
    std::fs::write(&outside, b"outside").unwrap();
    std::os::unix::fs::symlink(
        &regular,
        fixture
            .session_path("assets")
            .join("content/in-workspace.png"),
    )
    .unwrap();
    std::os::unix::fs::symlink(
        &outside,
        fixture.session_path("assets").join("content/escape.png"),
    )
    .unwrap();

    let bundle = current_bundle(fixture.worktree()).unwrap().unwrap();
    assert_eq!(
        bundle
            .assets
            .iter()
            .map(|asset| asset.name.as_str())
            .collect::<Vec<_>>(),
        ["regular.png"]
    );
}

#[test]
fn asset_bundle_omits_files_larger_than_the_individual_limit() {
    let fixture = Fixture::new();
    fixture.active_session("assets", "screen.html", "<h1>Screen</h1>");
    fixture.content(
        "assets",
        "too-large.bin",
        vec![0; MAX_COMPANION_ASSET_BYTES as usize + 1],
    );
    fixture.content("assets", "small.bin", b"small");

    let bundle = current_bundle(fixture.worktree()).unwrap().unwrap();
    assert_eq!(
        bundle
            .assets
            .iter()
            .map(|asset| asset.name.as_str())
            .collect::<Vec<_>>(),
        ["small.bin"]
    );
}

#[test]
fn asset_bundle_applies_count_limit_after_deterministic_bytewise_sorting() {
    let fixture = Fixture::new();
    fixture.active_session("assets", "screen.html", "<h1>Screen</h1>");
    for index in (0..=MAX_COMPANION_ASSET_COUNT).rev() {
        fixture.content(
            "assets",
            format!("asset-{index:02}.txt").as_str(),
            index.to_string(),
        );
    }

    let bundle = current_bundle(fixture.worktree()).unwrap().unwrap();
    let names = bundle
        .assets
        .iter()
        .map(|asset| asset.name.as_str())
        .collect::<Vec<_>>();
    assert_eq!(names.len(), MAX_COMPANION_ASSET_COUNT);
    assert_eq!(names.first(), Some(&"asset-00.txt"));
    assert_eq!(names.last(), Some(&"asset-31.txt"));
}

#[test]
fn asset_bundle_never_exceeds_total_unencoded_byte_limit() {
    use base64::Engine as _;

    let fixture = Fixture::new();
    fixture.active_session("assets", "screen.html", "<h1>Screen</h1>");
    for index in 0..5 {
        fixture.content(
            "assets",
            format!("asset-{index}.bin").as_str(),
            vec![index as u8; MAX_COMPANION_ASSET_BYTES as usize],
        );
    }

    let bundle = current_bundle(fixture.worktree()).unwrap().unwrap();
    assert_eq!(bundle.assets.len(), 4);
    let unencoded_bytes = bundle
        .assets
        .iter()
        .map(|asset| {
            base64::engine::general_purpose::STANDARD
                .decode(&asset.data_b64)
                .unwrap()
                .len()
        })
        .sum::<usize>();
    assert_eq!(unencoded_bytes as u64, MAX_COMPANION_ASSET_TOTAL_BYTES);
    assert_eq!(bundle.assets.last().unwrap().name, "asset-3.bin");
}

#[test]
fn asset_bundle_uses_common_mime_types_and_octet_stream_fallback() {
    let fixture = Fixture::new();
    fixture.active_session("assets", "screen.html", "<h1>Screen</h1>");
    for (name, _) in [
        ("app.css", "text/css"),
        ("app.js", "text/javascript"),
        ("data.json", "application/json"),
        ("font.woff2", "font/woff2"),
        ("image.svg", "image/svg+xml"),
        ("unknown.custom", "application/octet-stream"),
    ] {
        fixture.content("assets", name, b"x");
    }

    let bundle = current_bundle(fixture.worktree()).unwrap().unwrap();
    let mime_types = bundle
        .assets
        .iter()
        .map(|asset| (asset.name.as_str(), asset.content_type.as_str()))
        .collect::<Vec<_>>();
    assert_eq!(
        mime_types,
        [
            ("app.css", "text/css"),
            ("app.js", "application/octet-stream"),
            ("data.json", "application/octet-stream"),
            ("font.woff2", "font/woff2"),
            ("image.svg", "application/octet-stream"),
            ("unknown.custom", "application/octet-stream"),
        ]
    );
}

#[cfg(unix)]
#[test]
fn asset_bundle_omits_non_utf8_names_and_non_regular_entries_promptly() {
    use std::os::unix::ffi::OsStringExt as _;

    let fixture = Fixture::new();
    fixture.active_session("assets", "screen.html", "<h1>Screen</h1>");
    let content = fixture.session_path("assets").join("content");
    let invalid_name = std::ffi::OsString::from_vec(vec![b'i', b'n', b'v', 0xff]);
    if let Err(error) = std::fs::write(content.join(invalid_name), b"unsafe") {
        assert_eq!(
            error.raw_os_error(),
            Some(libc::EILSEQ),
            "unexpected failure creating non-UTF-8 fixture"
        );
    }
    std::fs::create_dir(content.join("directory.png")).unwrap();
    let fifo = content.join("pipe.png");
    let fifo_name =
        std::ffi::CString::new(std::os::unix::ffi::OsStrExt::as_bytes(fifo.as_os_str())).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo_name.as_ptr(), 0o600) }, 0);
    let short_content_link =
        PathBuf::from(format!("/tmp/kanna-asset-socket-{}", std::process::id()));
    let _ = std::fs::remove_file(&short_content_link);
    std::os::unix::fs::symlink(&content, &short_content_link).unwrap();
    let socket = std::os::unix::net::UnixListener::bind(short_content_link.join("socket.png"));
    std::fs::remove_file(&short_content_link).unwrap();
    let _socket = socket.unwrap();
    fixture.content("assets", "regular.png", b"regular");

    let started = std::time::Instant::now();
    let bundle = current_bundle(fixture.worktree()).unwrap().unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "asset discovery blocked on a non-regular entry"
    );
    assert_eq!(
        bundle
            .assets
            .iter()
            .map(|asset| asset.name.as_str())
            .collect::<Vec<_>>(),
        ["regular.png"]
    );
}

#[test]
fn asset_byte_changes_update_digest_and_bundle_revision() {
    let fixture = Fixture::new();
    fixture.active_session("assets", "screen.html", "<h1>Unchanged</h1>");
    fixture.content("assets", "layout.png", b"first");
    let first = current_bundle(fixture.worktree()).unwrap().unwrap();

    fixture.content("assets", "layout.png", b"second");
    let second = current_bundle(fixture.worktree()).unwrap().unwrap();

    assert_eq!(first.html, second.html);
    assert_ne!(first.assets[0].digest, second.assets[0].digest);
    assert_ne!(first.revision, second.revision);
}

#[test]
fn directory_entry_ceiling_returns_a_deterministic_error_without_a_partial_bundle() {
    let fixture = Fixture::new();
    fixture.active_session("active", "screen.html", "<h1>Screen</h1>");
    for index in 0..MAX_COMPANION_DIRECTORY_ENTRIES {
        fixture.write(
            format!(".superpowers/brainstorm/extra-{index:04}"),
            b"entry",
        );
    }

    assert_eq!(
        current_bundle(fixture.worktree()),
        Err(CompanionError::TooLarge)
    );
    assert_eq!(
        current_bundle(fixture.worktree()),
        Err(CompanionError::TooLarge)
    );
}

#[test]
fn directory_name_byte_ceiling_returns_an_error_before_materialization() {
    let fixture = Fixture::new();
    fixture.active_session("active", "screen.html", "<h1>Screen</h1>");
    let mut name_bytes = "screen.html".len();
    let mut index = 0;
    while name_bytes <= MAX_COMPANION_DIRECTORY_NAME_BYTES {
        let name = format!("{index:04}-{}.bin", "x".repeat(230));
        name_bytes += name.len();
        fixture.content("active", &name, b"x");
        index += 1;
    }
    assert!(index < MAX_COMPANION_DIRECTORY_ENTRIES);

    assert_eq!(
        current_bundle(fixture.worktree()),
        Err(CompanionError::TooLarge)
    );
}

#[cfg(unix)]
#[test]
fn directory_reader_errors_are_not_mistaken_for_eof() {
    let mut reads = 0;
    let result = crate::discovery::collect_directory_names_for_test(|| {
        reads += 1;
        match reads {
            1 => Ok(Some(std::ffi::OsString::from("one"))),
            _ => Err(std::io::Error::from_raw_os_error(libc::EIO)),
        }
    });

    assert!(matches!(result, Err(CompanionError::Internal(_))));
}

#[test]
fn scanner_skips_materialization_for_an_unchanged_tree() {
    let fixture = Fixture::new();
    fixture.active_session("active", "screen.html", "<h1>Screen</h1>");
    fixture.content("active", "large.bin", vec![b'x'; 1024 * 1024]);
    let mut scanner = CompanionScanner::new();

    assert!(matches!(
        scanner.scan(fixture.worktree()).unwrap(),
        CompanionScan::Changed(Some(_))
    ));
    assert_eq!(scanner.materialization_count(), 1);
    assert_eq!(
        scanner.scan(fixture.worktree()).unwrap(),
        CompanionScan::Unchanged
    );
    assert_eq!(scanner.materialization_count(), 1);
}

#[cfg(unix)]
#[test]
fn assetless_scanner_skips_asset_payload_materialization_and_caches_the_tree() {
    for stage in [
        crate::discovery::OptionalFailureStage::Open,
        crate::discovery::OptionalFailureStage::Metadata,
        crate::discovery::OptionalFailureStage::Read,
    ] {
        let fixture = Fixture::new();
        fixture.active_session("active", "screen.html", "<h1>Screen</h1>");
        fixture.content(
            "active",
            "maximum.bin",
            vec![b'x'; MAX_COMPANION_ASSET_BYTES as usize],
        );
        let _failure = crate::discovery::inject_optional_materialization_failure_for_test(
            "maximum.bin",
            stage,
        );
        let mut scanner = CompanionScanner::new();

        let CompanionScan::Changed(Some(bundle)) =
            scanner.scan_with_assets(fixture.worktree(), false).unwrap()
        else {
            panic!("expected assetless companion with {stage:?} failure");
        };
        assert!(bundle.assets.is_empty());
        assert_eq!(scanner.materialization_count(), 1);
        assert_eq!(
            scanner.scan_with_assets(fixture.worktree(), false).unwrap(),
            CompanionScan::Unchanged
        );
        assert_eq!(scanner.materialization_count(), 1);
    }
}

#[cfg(unix)]
#[test]
fn scanner_cache_identity_tracks_asset_demand_mode() {
    let fixture = Fixture::new();
    fixture.active_session("active", "screen.html", "<h1>Screen</h1>");
    fixture.content("active", "screen.png", b"asset bytes");
    let mut scanner = CompanionScanner::new();

    let CompanionScan::Changed(Some(first_assetless)) =
        scanner.scan_with_assets(fixture.worktree(), false).unwrap()
    else {
        panic!("expected initial assetless companion");
    };
    assert!(first_assetless.assets.is_empty());
    assert_eq!(scanner.materialization_count(), 1);

    let CompanionScan::Changed(Some(with_assets)) =
        scanner.scan_with_assets(fixture.worktree(), true).unwrap()
    else {
        panic!("expected companion after enabling assets");
    };
    assert_eq!(
        with_assets
            .assets
            .iter()
            .map(|asset| asset.name.as_str())
            .collect::<Vec<_>>(),
        ["screen.png"]
    );
    assert_eq!(scanner.materialization_count(), 2);

    let CompanionScan::Changed(Some(second_assetless)) =
        scanner.scan_with_assets(fixture.worktree(), false).unwrap()
    else {
        panic!("expected companion after disabling assets");
    };
    assert!(second_assetless.assets.is_empty());
    assert_eq!(scanner.materialization_count(), 3);
}

#[cfg(unix)]
#[test]
fn assetless_scanner_reserves_the_assetless_materialization_budget() {
    let fixture = Fixture::new();
    fixture.active_session("active", "screen.html", "<h1>Screen</h1>");
    fixture.content("active", "screen.png", b"asset bytes");
    let budget = Arc::new(CompanionMaterializationBudget::new(
        1,
        MAX_COMPANION_ASSETLESS_MATERIALIZED_BYTES,
    ));
    let mut assetless_scanner = CompanionScanner::with_materialization_budget(Arc::clone(&budget));

    assert!(matches!(
        assetless_scanner
            .scan_with_assets(fixture.worktree(), false)
            .unwrap(),
        CompanionScan::Changed(Some(_))
    ));
    assert_eq!(budget.retained_bytes(), 0);

    let mut full_scanner = CompanionScanner::with_materialization_budget(budget);
    assert_eq!(
        full_scanner.scan_with_assets(fixture.worktree(), true),
        Err(CompanionError::Internal(
            "visual companion materialization budget is busy".into()
        ))
    );
}

#[cfg(unix)]
#[test]
fn scanner_retries_transient_server_info_failures_without_metadata_changes() {
    let fixture = Fixture::new();
    fixture.active_session("active", "screen.html", "<h1>Screen</h1>");
    fixture.server_info("active", r#"{"url":"http://localhost:52341"}"#);
    for stage in [
        crate::discovery::OptionalFailureStage::Open,
        crate::discovery::OptionalFailureStage::Metadata,
        crate::discovery::OptionalFailureStage::Read,
    ] {
        let mut scanner = CompanionScanner::new();
        let failure = crate::discovery::inject_optional_materialization_failure_for_test(
            "server-info",
            stage,
        );
        let direct = current_bundle(fixture.worktree()).unwrap().unwrap();
        assert_eq!(direct.source_origin, None);
        let CompanionScan::Changed(Some(degraded)) = scanner.scan(fixture.worktree()).unwrap()
        else {
            panic!("expected degraded companion after {stage:?} failure");
        };
        assert_eq!(degraded.source_origin, None);
        assert_eq!(scanner.materialization_count(), 1);
        drop(failure);

        let CompanionScan::Changed(Some(recovered)) = scanner.scan(fixture.worktree()).unwrap()
        else {
            panic!("expected unchanged metadata to be rematerialized");
        };
        assert_eq!(
            recovered.source_origin.as_deref(),
            Some("http://localhost:52341")
        );
        assert_eq!(scanner.materialization_count(), 2);
        assert_eq!(
            scanner.scan(fixture.worktree()).unwrap(),
            CompanionScan::Unchanged
        );
        assert_eq!(scanner.materialization_count(), 2);
    }
}

#[cfg(unix)]
#[test]
fn scanner_retries_transient_asset_failures_without_metadata_changes() {
    let fixture = Fixture::new();
    fixture.active_session("active", "screen.html", "<h1>Screen</h1>");
    fixture.content("active", "screen.png", b"asset bytes");
    for stage in [
        crate::discovery::OptionalFailureStage::Open,
        crate::discovery::OptionalFailureStage::Metadata,
        crate::discovery::OptionalFailureStage::Read,
    ] {
        let mut scanner = CompanionScanner::new();
        let failure =
            crate::discovery::inject_optional_materialization_failure_for_test("screen.png", stage);
        let direct = current_bundle(fixture.worktree()).unwrap().unwrap();
        assert!(direct.assets.is_empty());
        let CompanionScan::Changed(Some(degraded)) = scanner.scan(fixture.worktree()).unwrap()
        else {
            panic!("expected degraded companion after {stage:?} failure");
        };
        assert!(degraded.assets.is_empty());
        assert_eq!(scanner.materialization_count(), 1);
        drop(failure);

        let CompanionScan::Changed(Some(recovered)) = scanner.scan(fixture.worktree()).unwrap()
        else {
            panic!("expected unchanged metadata to be rematerialized");
        };
        assert_eq!(
            recovered
                .assets
                .iter()
                .map(|asset| asset.name.as_str())
                .collect::<Vec<_>>(),
            ["screen.png"]
        );
        assert_eq!(scanner.materialization_count(), 2);
        assert_eq!(
            scanner.scan(fixture.worktree()).unwrap(),
            CompanionScan::Unchanged
        );
        assert_eq!(scanner.materialization_count(), 2);
    }
}

#[cfg(unix)]
#[test]
fn scanner_caches_definitive_optional_omissions() {
    let missing = Fixture::new();
    let mut missing_scanner = CompanionScanner::new();
    assert_eq!(
        missing_scanner.scan(missing.worktree()).unwrap(),
        CompanionScan::Changed(None)
    );
    assert_eq!(
        missing_scanner.scan(missing.worktree()).unwrap(),
        CompanionScan::Unchanged
    );

    let invalid = Fixture::new();
    invalid.active_session("active", "screen.html", "<h1>Screen</h1>");
    invalid.server_info("active", b"not-json");
    let mut invalid_scanner = CompanionScanner::new();
    let CompanionScan::Changed(Some(invalid_bundle)) =
        invalid_scanner.scan(invalid.worktree()).unwrap()
    else {
        panic!("expected companion with omitted invalid origin");
    };
    assert_eq!(invalid_bundle.source_origin, None);
    assert_eq!(
        invalid_scanner.scan(invalid.worktree()).unwrap(),
        CompanionScan::Unchanged
    );

    let oversized = Fixture::new();
    oversized.active_session("active", "screen.html", "<h1>Screen</h1>");
    oversized.server_info("active", vec![b'x'; 16 * 1024 + 1]);
    oversized.content(
        "active",
        "oversized.png",
        vec![b'x'; MAX_COMPANION_ASSET_BYTES as usize + 1],
    );
    let mut oversized_scanner = CompanionScanner::new();
    let CompanionScan::Changed(Some(oversized_bundle)) =
        oversized_scanner.scan(oversized.worktree()).unwrap()
    else {
        panic!("expected companion with oversized optional files omitted");
    };
    assert_eq!(oversized_bundle.source_origin, None);
    assert!(oversized_bundle.assets.is_empty());
    assert_eq!(
        oversized_scanner.scan(oversized.worktree()).unwrap(),
        CompanionScan::Unchanged
    );

    let symlinked = Fixture::new();
    symlinked.active_session("active", "screen.html", "<h1>Screen</h1>");
    symlinked.content("active", "regular.png", b"regular");
    let outside = symlinked.write("outside", b"unsafe");
    let server_info = symlinked.server_info("active", b"{}");
    std::fs::remove_file(&server_info).unwrap();
    std::os::unix::fs::symlink(&outside, &server_info).unwrap();
    std::os::unix::fs::symlink(
        &outside,
        symlinked.session_path("active").join("content/linked.png"),
    )
    .unwrap();
    let mut symlink_scanner = CompanionScanner::new();
    let CompanionScan::Changed(Some(symlink_bundle)) =
        symlink_scanner.scan(symlinked.worktree()).unwrap()
    else {
        panic!("expected companion with symlinked optional files omitted");
    };
    assert_eq!(symlink_bundle.source_origin, None);
    assert_eq!(
        symlink_bundle
            .assets
            .iter()
            .map(|asset| asset.name.as_str())
            .collect::<Vec<_>>(),
        ["regular.png"]
    );
    assert_eq!(
        symlink_scanner.scan(symlinked.worktree()).unwrap(),
        CompanionScan::Unchanged
    );
}

#[test]
fn scanner_detects_document_asset_origin_and_session_changes() {
    let fixture = Fixture::new();
    fixture.active_session("active", "screen.html", "<h1>Screen</h1>");
    fixture.server_info("active", r#"{"url":"http://localhost:52341"}"#);
    fixture.content("active", "asset.bin", b"one");
    let mut scanner = CompanionScanner::new();
    assert!(matches!(
        scanner.scan(fixture.worktree()).unwrap(),
        CompanionScan::Changed(Some(_))
    ));

    fixture.content("active", "screen.html", "<h1>Changed document</h1>");
    assert!(matches!(
        scanner.scan(fixture.worktree()).unwrap(),
        CompanionScan::Changed(Some(_))
    ));

    fixture.content("active", "asset.bin", b"changed asset bytes");
    assert!(matches!(
        scanner.scan(fixture.worktree()).unwrap(),
        CompanionScan::Changed(Some(_))
    ));

    fixture.server_info("active", r#"{"url":"http://localhost:52342"}"#);
    let CompanionScan::Changed(Some(bundle)) = scanner.scan(fixture.worktree()).unwrap() else {
        panic!("origin metadata change was not detected");
    };
    assert_eq!(
        bundle.source_origin.as_deref(),
        Some("http://localhost:52342")
    );

    fixture.write(".superpowers/brainstorm/active/state/server-stopped", b"{}");
    assert_eq!(
        scanner.scan(fixture.worktree()).unwrap(),
        CompanionScan::Changed(None)
    );
    std::fs::remove_file(fixture.session_path("active").join("state/server-stopped")).unwrap();
    assert!(matches!(
        scanner.scan(fixture.worktree()).unwrap(),
        CompanionScan::Changed(Some(_))
    ));
}

#[test]
fn scanner_detects_workspace_identity_replacement() {
    let fixture = Fixture::new();
    fixture.active_session("old", "screen.html", "<h1>Same bytes</h1>");
    let mut scanner = CompanionScanner::new();
    assert!(matches!(
        scanner.scan(fixture.worktree()).unwrap(),
        CompanionScan::Changed(Some(_))
    ));

    let departed = fixture.temp_dir.path().join("departed-scanner-workspace");
    std::fs::rename(fixture.worktree(), departed).unwrap();
    std::fs::create_dir_all(fixture.worktree()).unwrap();
    fixture.active_session("new", "screen.html", "<h1>Same bytes</h1>");

    let CompanionScan::Changed(Some(bundle)) = scanner.scan(fixture.worktree()).unwrap() else {
        panic!("workspace replacement was not detected");
    };
    assert_eq!(bundle.session_id, "new");
}

#[test]
fn scanner_recovers_after_a_source_error_is_fixed() {
    let fixture = Fixture::new();
    fixture.active_session("active", "screen.html", "<h1>Screen</h1>");
    let mut scanner = CompanionScanner::new();
    assert!(matches!(
        scanner.scan(fixture.worktree()).unwrap(),
        CompanionScan::Changed(Some(_))
    ));

    fixture.content(
        "active",
        "screen.html",
        vec![b'x'; MAX_COMPANION_HTML_BYTES as usize + 1],
    );
    assert_eq!(
        scanner.scan(fixture.worktree()),
        Err(CompanionError::TooLarge)
    );

    fixture.content("active", "screen.html", "<h1>Screen</h1>");
    assert!(matches!(
        scanner.scan(fixture.worktree()).unwrap(),
        CompanionScan::Changed(Some(_))
    ));
}

#[test]
fn appends_one_compatible_jsonl_event_after_authoritative_validation() {
    let fixture = Fixture::new();
    fixture.active_session(
        "123-456",
        "layout.html",
        b"<button data-choice='a'>A</button>",
    );
    let document = current_bundle(fixture.worktree()).unwrap().unwrap();
    let event = Fixture::event_for(&document);

    append_event(
        fixture.worktree(),
        &document.session_id,
        &document.revision,
        &event,
    )
    .unwrap();

    let line =
        std::fs::read_to_string(fixture.session_path("123-456").join("state/events")).unwrap();
    let value: serde_json::Value = serde_json::from_str(line.trim_end()).unwrap();
    assert_eq!(value["type"], "click");
    assert_eq!(value["choice"], "a");
    assert_eq!(value["id"], serde_json::Value::Null);
    assert_eq!(value["event_id"], "event-1");
}

#[test]
fn maximum_asset_event_validation_stays_below_payload_materialization_latency() {
    let fixture = Fixture::new();
    fixture.active_session("123-456", "layout.html", b"<button>Choose</button>");
    let asset_bytes = (MAX_COMPANION_ASSET_TOTAL_BYTES as usize) / MAX_COMPANION_ASSET_COUNT;
    for index in 0..MAX_COMPANION_ASSET_COUNT {
        fixture.content(
            "123-456",
            &format!("asset-{index:02}.bin"),
            vec![index as u8; asset_bytes],
        );
    }
    let document = current_bundle(fixture.worktree()).unwrap().unwrap();
    assert_eq!(document.assets.len(), MAX_COMPANION_ASSET_COUNT);
    let event = Fixture::event_for(&document);

    let started = Instant::now();
    append_event(
        fixture.worktree(),
        &document.session_id,
        &document.revision,
        &event,
    )
    .unwrap();

    assert!(
        started.elapsed() < Duration::from_millis(250),
        "maximum-asset event validation rematerialized payloads for {:?}",
        started.elapsed()
    );
}

#[test]
fn appends_after_newline_terminated_legacy_history_without_rewriting_it() {
    let fixture = Fixture::new();
    fixture.active_session("123-456", "layout.html", b"screen");
    let document = current_bundle(fixture.worktree()).unwrap().unwrap();
    let mut historic = Fixture::event_for(&document);
    historic.event_id = "legacy-event".into();
    let mut current = Fixture::event_for(&document);
    current.event_id = "current-event".into();
    let events_path = fixture.session_path("123-456").join("state/events");
    let legacy_line = format!("{}\n", serde_json::to_string(&historic).unwrap());
    std::fs::write(&events_path, &legacy_line).unwrap();

    append_event(
        fixture.worktree(),
        &document.session_id,
        &document.revision,
        &current,
    )
    .unwrap();

    let contents = std::fs::read_to_string(events_path).unwrap();
    assert!(contents.starts_with(&legacy_line));
    assert_eq!(
        contents
            .lines()
            .map(|line| serde_json::from_str::<CompanionEvent>(line).unwrap())
            .collect::<Vec<_>>(),
        vec![historic, current]
    );
}

#[test]
fn repairs_a_partial_old_shape_legacy_tail_and_repeated_append_is_idempotent() {
    let fixture = Fixture::new();
    fixture.active_session("123-456", "layout.html", b"screen");
    let document = current_bundle(fixture.worktree()).unwrap().unwrap();
    let current = Fixture::event_for(&document);
    let events_path = fixture.session_path("123-456").join("state/events");
    let complete = concat!(
        "{\"event_id\":\"legacy-event\",\"type\":\"click\",",
        "\"choice\":\"old-layout\",\"text\":\"Old layout\",",
        "\"id\":null,\"timestamp\":7}\n"
    );
    let malformed = format!("{complete}{{\"event_id\":\"partial");
    std::fs::write(&events_path, malformed.as_bytes()).unwrap();

    for _ in 0..2 {
        append_event(
            fixture.worktree(),
            &document.session_id,
            &document.revision,
            &current,
        )
        .unwrap();
    }

    let contents = std::fs::read_to_string(&events_path).unwrap();
    assert!(contents.starts_with(complete));
    let records = contents
        .lines()
        .map(|line| serde_json::from_str::<CompanionEvent>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(records.len(), 2);
    assert_eq!(records[0].session_id, "");
    assert_eq!(records[0].revision, "");
    assert_eq!(records[0].event_id, "legacy-event");
    assert_eq!(records[1], current);
}

#[cfg(unix)]
#[test]
fn append_rejects_an_oversized_sparse_legacy_tail_without_unbounded_delay() {
    let fixture = Fixture::new();
    fixture.active_session("123-456", "layout.html", b"screen");
    let document = current_bundle(fixture.worktree()).unwrap().unwrap();
    let event = Fixture::event_for(&document);
    let events_path = fixture.session_path("123-456").join("state/events");
    let events = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(events_path)
        .unwrap();
    events.set_len(64 * 1024 * 1024 * 1024).unwrap();
    drop(events);

    let started = Instant::now();
    let result = append_event(
        fixture.worktree(),
        &document.session_id,
        &document.revision,
        &event,
    );

    assert_eq!(
        result,
        Err(CompanionError::Internal(
            "visual companion events contains an oversized legacy tail".into()
        ))
    );
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "append held the event journal lock for {:?}",
        started.elapsed()
    );
}

#[test]
fn duplicate_event_identity_is_idempotent_but_conflicting_payload_is_rejected() {
    let fixture = Fixture::new();
    fixture.active_session("123-456", "layout.html", b"screen");
    let document = current_bundle(fixture.worktree()).unwrap().unwrap();
    let event = Fixture::event_for(&document);

    append_event(
        fixture.worktree(),
        &document.session_id,
        &document.revision,
        &event,
    )
    .unwrap();
    append_event(
        fixture.worktree(),
        &document.session_id,
        &document.revision,
        &event,
    )
    .unwrap();

    let mut conflict = event.clone();
    conflict.choice = "different".into();
    assert_eq!(
        append_event(
            fixture.worktree(),
            &document.session_id,
            &document.revision,
            &conflict,
        ),
        Err(CompanionError::InvalidEvent)
    );
    let contents =
        std::fs::read_to_string(fixture.session_path("123-456").join("state/events")).unwrap();
    assert_eq!(contents.lines().count(), 1);
}

#[test]
fn concurrent_duplicate_writers_append_exactly_once() {
    let fixture = Fixture::new();
    fixture.active_session("123-456", "layout.html", b"screen");
    let document = current_bundle(fixture.worktree()).unwrap().unwrap();
    let event = Fixture::event_for(&document);
    let workspace = Arc::new(fixture.worktree().to_path_buf());
    let barrier = Arc::new(std::sync::Barrier::new(8));
    let writers = (0..8)
        .map(|_| {
            let workspace = Arc::clone(&workspace);
            let barrier = Arc::clone(&barrier);
            let session_id = document.session_id.clone();
            let revision = document.revision.clone();
            let event = event.clone();
            std::thread::spawn(move || {
                barrier.wait();
                append_event(&workspace, &session_id, &revision, &event)
            })
        })
        .collect::<Vec<_>>();
    for writer in writers {
        writer.join().unwrap().unwrap();
    }

    let contents =
        std::fs::read_to_string(fixture.session_path("123-456").join("state/events")).unwrap();
    assert_eq!(contents.lines().count(), 1);
}

#[test]
fn committed_identity_survives_more_than_eight_mebibytes_of_legal_history() {
    use std::io::Write;

    let fixture = Fixture::new();
    fixture.active_session("123-456", "layout.html", b"screen");
    let document = current_bundle(fixture.worktree()).unwrap().unwrap();
    let event = Fixture::event_for(&document);
    append_event(
        fixture.worktree(),
        &document.session_id,
        &document.revision,
        &event,
    )
    .unwrap();
    let events_path = fixture.session_path("123-456").join("state/events");
    let mut events = std::fs::OpenOptions::new()
        .append(true)
        .open(&events_path)
        .unwrap();
    let mut index = 0usize;
    while events.metadata().unwrap().len() <= 8 * 1024 * 1024 + 16 * 1024 {
        let mut historic = Fixture::event_for(&document);
        historic.event_id = format!("history-{index}");
        historic.text = "x".repeat(4096);
        serde_json::to_writer(&mut events, &historic).unwrap();
        events.write_all(b"\n").unwrap();
        index += 1;
    }
    events.sync_all().unwrap();
    let length_before_retry = events.metadata().unwrap().len();
    drop(events);

    append_event(
        fixture.worktree(),
        &document.session_id,
        &document.revision,
        &event,
    )
    .unwrap();
    assert_eq!(
        std::fs::metadata(events_path).unwrap().len(),
        length_before_retry
    );
}

#[test]
fn partial_pending_marker_is_rewritten_before_append_begins() {
    let fixture = Fixture::new();
    fixture.active_session("123-456", "layout.html", b"screen");
    let document = current_bundle(fixture.worktree()).unwrap().unwrap();
    let event = Fixture::event_for(&document);
    let state = fixture.session_path("123-456").join("state");
    let marker_dir = state.join("event-idempotency");
    std::fs::create_dir_all(&marker_dir).unwrap();
    let (pending_name, committed_name) = crate::event::marker_names(&event.event_id);
    std::fs::write(marker_dir.join(&pending_name), b"partial").unwrap();

    append_event(
        fixture.worktree(),
        &document.session_id,
        &document.revision,
        &event,
    )
    .unwrap();

    assert_eq!(
        std::fs::read_to_string(state.join("events"))
            .unwrap()
            .lines()
            .count(),
        1
    );
    assert!(!marker_dir.join(pending_name).exists());
    let marker = std::fs::read_to_string(marker_dir.join(committed_name)).unwrap();
    let mut lines = marker.lines();
    assert_eq!(lines.next(), Some("0"));
    assert_eq!(
        serde_json::from_str::<CompanionEvent>(lines.next().unwrap()).unwrap(),
        event
    );
    assert_eq!(lines.next(), None);
}

#[test]
fn interrupted_event_writes_recover_at_every_record_boundary() {
    for boundary_kind in 0..5 {
        let fixture = Fixture::new();
        fixture.active_session("123-456", "layout.html", b"screen");
        let document = current_bundle(fixture.worktree()).unwrap().unwrap();
        let event = Fixture::event_for(&document);
        let serialized = serde_json::to_string(&event).unwrap();
        let line = format!("{serialized}\n");
        let boundary = [0, 1, line.len() / 2, line.len() - 1, line.len()][boundary_kind];
        let state = fixture.session_path("123-456").join("state");
        let marker_dir = state.join("event-idempotency");
        std::fs::create_dir_all(&marker_dir).unwrap();
        let (pending_name, committed_name) = crate::event::marker_names(&event.event_id);
        std::fs::write(marker_dir.join(&pending_name), format!("0\n{serialized}\n")).unwrap();
        std::fs::write(state.join("events"), &line.as_bytes()[..boundary]).unwrap();

        append_event(
            fixture.worktree(),
            &document.session_id,
            &document.revision,
            &event,
        )
        .unwrap();

        assert_eq!(std::fs::read_to_string(state.join("events")).unwrap(), line);
        assert!(!marker_dir.join(pending_name).exists());
        assert!(marker_dir.join(committed_name).exists());
    }
}

#[test]
fn a_new_event_first_finishes_an_interrupted_pending_event() {
    let fixture = Fixture::new();
    fixture.active_session("123-456", "layout.html", b"screen");
    let document = current_bundle(fixture.worktree()).unwrap().unwrap();
    let first = Fixture::event_for(&document);
    let mut second = first.clone();
    second.event_id = "event-2".into();
    second.choice = "b".into();
    second.text = "Option B".into();
    let state = fixture.session_path("123-456").join("state");
    let marker_dir = state.join("event-idempotency");
    std::fs::create_dir_all(&marker_dir).unwrap();
    let (pending_name, committed_name) = crate::event::marker_names(&first.event_id);
    let first_serialized = serde_json::to_string(&first).unwrap();
    std::fs::write(
        marker_dir.join(&pending_name),
        format!("0\n{first_serialized}\n"),
    )
    .unwrap();
    std::fs::write(state.join("events"), &first_serialized.as_bytes()[..17]).unwrap();

    append_event(
        fixture.worktree(),
        &document.session_id,
        &document.revision,
        &second,
    )
    .unwrap();

    let events = std::fs::read_to_string(state.join("events")).unwrap();
    assert_eq!(
        events
            .lines()
            .map(|line| serde_json::from_str::<CompanionEvent>(line).unwrap())
            .collect::<Vec<_>>(),
        vec![first, second]
    );
    assert!(!marker_dir.join(pending_name).exists());
    assert!(marker_dir.join(committed_name).exists());
}

#[test]
fn replaced_legacy_event_log_discards_a_committed_marker_before_append() {
    let fixture = Fixture::new();
    fixture.active_session("123-456", "layout.html", b"old screen");
    let old_document = current_bundle(fixture.worktree()).unwrap().unwrap();
    let old_event = Fixture::event_for(&old_document);
    let state = fixture.session_path("123-456").join("state");
    let events_path = state.join("events");
    let marker_dir = state.join("event-idempotency");
    std::fs::create_dir_all(&marker_dir).unwrap();
    let old_serialized = serde_json::to_string(&old_event).unwrap();
    std::fs::write(&events_path, format!("{old_serialized}\n")).unwrap();
    let (_, old_committed_name) = crate::event::marker_names(&old_event.event_id);
    std::fs::write(
        marker_dir.join(&old_committed_name),
        format!("0\n{old_serialized}\n"),
    )
    .unwrap();

    fixture.content("123-456", "layout.html", b"replacement screen");
    std::fs::remove_file(&events_path).unwrap();
    std::fs::write(&events_path, b"").unwrap();
    let new_document = current_bundle(fixture.worktree()).unwrap().unwrap();
    assert_ne!(new_document.revision, old_document.revision);
    let mut new_event = Fixture::event_for(&new_document);
    new_event.event_id = "replacement-event".into();

    append_event(
        fixture.worktree(),
        &new_document.session_id,
        &new_document.revision,
        &new_event,
    )
    .unwrap();

    let records = std::fs::read_to_string(&events_path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<CompanionEvent>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(records, vec![new_event.clone()]);
    assert!(!marker_dir.join(old_committed_name).exists());
    let (_, new_committed_name) = crate::event::marker_names(&new_event.event_id);
    assert!(marker_dir.join(new_committed_name).exists());
}

#[test]
fn replaced_legacy_event_log_discards_a_pending_marker_without_replay() {
    let fixture = Fixture::new();
    fixture.active_session("123-456", "layout.html", b"old screen");
    let old_document = current_bundle(fixture.worktree()).unwrap().unwrap();
    let old_event = Fixture::event_for(&old_document);
    let state = fixture.session_path("123-456").join("state");
    let events_path = state.join("events");
    let marker_dir = state.join("event-idempotency");
    std::fs::create_dir_all(&marker_dir).unwrap();
    let old_serialized = serde_json::to_string(&old_event).unwrap();
    let (old_pending_name, _) = crate::event::marker_names(&old_event.event_id);
    std::fs::write(
        marker_dir.join(&old_pending_name),
        format!("0\n{old_serialized}\n"),
    )
    .unwrap();
    std::fs::write(&events_path, &old_serialized.as_bytes()[..17]).unwrap();

    fixture.content("123-456", "layout.html", b"replacement screen");
    std::fs::remove_file(&events_path).unwrap();
    std::fs::write(&events_path, b"").unwrap();
    let new_document = current_bundle(fixture.worktree()).unwrap().unwrap();
    assert_ne!(new_document.revision, old_document.revision);
    let mut new_event = Fixture::event_for(&new_document);
    new_event.event_id = "replacement-event".into();

    append_event(
        fixture.worktree(),
        &new_document.session_id,
        &new_document.revision,
        &new_event,
    )
    .unwrap();

    let records = std::fs::read_to_string(&events_path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<CompanionEvent>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(records, vec![new_event]);
    assert!(!marker_dir.join(old_pending_name).exists());
}

#[test]
fn committed_marker_is_rejected_when_its_event_record_disappears() {
    let fixture = Fixture::new();
    fixture.active_session("123-456", "layout.html", b"screen");
    let document = current_bundle(fixture.worktree()).unwrap().unwrap();
    let event = Fixture::event_for(&document);
    append_event(
        fixture.worktree(),
        &document.session_id,
        &document.revision,
        &event,
    )
    .unwrap();
    std::fs::write(fixture.session_path("123-456").join("state/events"), b"").unwrap();

    assert!(matches!(
        append_event(
            fixture.worktree(),
            &document.session_id,
            &document.revision,
            &event,
        ),
        Err(CompanionError::Internal(message)) if message.contains("missing")
    ));
}

#[cfg(unix)]
#[test]
fn hardlinked_marker_is_rejected_without_truncating_its_target() {
    let fixture = Fixture::new();
    fixture.active_session("123-456", "layout.html", b"screen");
    let document = current_bundle(fixture.worktree()).unwrap().unwrap();
    let event = Fixture::event_for(&document);
    let state = fixture.session_path("123-456").join("state");
    let marker_dir = state.join("event-idempotency");
    std::fs::create_dir_all(&marker_dir).unwrap();
    let victim = state.join("victim");
    let victim_contents = b"must remain intact";
    std::fs::write(&victim, victim_contents).unwrap();
    let (pending_name, _) = crate::event::marker_names(&event.event_id);
    std::fs::hard_link(&victim, marker_dir.join(pending_name)).unwrap();

    assert!(matches!(
        append_event(
            fixture.worktree(),
            &document.session_id,
            &document.revision,
            &event,
        ),
        Err(CompanionError::Internal(message)) if message.contains("unsafe identity")
    ));
    assert_eq!(std::fs::read(victim).unwrap(), victim_contents);
}

#[test]
fn marker_storage_is_bounded_after_real_event_churn() {
    let fixture = Fixture::new();
    fixture.active_session("123-456", "layout.html", b"screen");
    let document = current_bundle(fixture.worktree()).unwrap().unwrap();
    for index in 0..64 {
        let mut event = Fixture::event_for(&document);
        event.event_id = format!("event-{index}");
        append_event(
            fixture.worktree(),
            &document.session_id,
            &document.revision,
            &event,
        )
        .unwrap();
    }
    let marker_dir = fixture
        .session_path("123-456")
        .join("state/event-idempotency");
    let marker_names = std::fs::read_dir(&marker_dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<Vec<_>>();
    assert_eq!(marker_names.len(), 65);
    assert_eq!(
        marker_names
            .iter()
            .filter(|name| name.to_string_lossy().ends_with(".committed"))
            .count(),
        64
    );
    assert!(marker_names
        .iter()
        .any(|name| name.to_string_lossy().starts_with("events-generation-")));

    for index in 64..crate::event::MAX_EVENT_IDENTITIES_PER_SESSION {
        // Production-shaped synthetic names keep this test honest against the
        // directory's cumulative basename-byte ceiling without paying for
        // thousands of fsync-heavy real appends.
        std::fs::write(marker_dir.join(format!("{index:064x}.committed")), b"").unwrap();
    }
    let mut rejected = Fixture::event_for(&document);
    rejected.event_id = "one-too-many".into();
    assert!(matches!(
        append_event(
            fixture.worktree(),
            &document.session_id,
            &document.revision,
            &rejected,
        ),
        Err(CompanionError::Internal(message)) if message.contains("identity limit")
    ));
    assert_eq!(
        std::fs::read_dir(marker_dir).unwrap().count(),
        crate::event::MAX_EVENT_IDENTITIES_PER_SESSION + 1
    );
}

#[test]
fn pending_marker_recovers_exact_offset_after_unbounded_later_churn() {
    use std::io::Write;

    let fixture = Fixture::new();
    fixture.active_session("123-456", "layout.html", b"screen");
    let document = current_bundle(fixture.worktree()).unwrap().unwrap();
    let event = Fixture::event_for(&document);
    let state = fixture.session_path("123-456").join("state");
    let events_path = state.join("events");
    let marker_dir = state.join("event-idempotency");
    std::fs::create_dir_all(&marker_dir).unwrap();
    let (pending_name, committed_name) = crate::event::marker_names(&event.event_id);
    let serialized = serde_json::to_string(&event).unwrap();
    std::fs::write(marker_dir.join(&pending_name), format!("0\n{serialized}\n")).unwrap();
    let mut events = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&events_path)
        .unwrap();
    writeln!(events, "{serialized}").unwrap();
    let mut index = 0usize;
    while events.metadata().unwrap().len() <= 8 * 1024 * 1024 + 16 * 1024 {
        let mut historic = Fixture::event_for(&document);
        historic.event_id = format!("later-{index}");
        historic.text = "x".repeat(4096);
        serde_json::to_writer(&mut events, &historic).unwrap();
        events.write_all(b"\n").unwrap();
        index += 1;
    }
    events.sync_all().unwrap();
    let length_before_retry = events.metadata().unwrap().len();
    drop(events);

    append_event(
        fixture.worktree(),
        &document.session_id,
        &document.revision,
        &event,
    )
    .unwrap();

    assert_eq!(
        std::fs::metadata(events_path).unwrap().len(),
        length_before_retry
    );
    assert!(!marker_dir.join(pending_name).exists());
    assert!(marker_dir.join(committed_name).exists());
}

#[cfg(unix)]
#[test]
fn event_lock_wait_is_bounded() {
    use std::os::fd::AsRawFd;

    let fixture = Fixture::new();
    fixture.active_session("123-456", "layout.html", b"screen");
    let document = current_bundle(fixture.worktree()).unwrap().unwrap();
    let events_path = fixture.session_path("123-456").join("state/events");
    let locked = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(events_path)
        .unwrap();
    assert_eq!(unsafe { libc::flock(locked.as_raw_fd(), libc::LOCK_EX) }, 0);
    let started = std::time::Instant::now();
    let result = append_event(
        fixture.worktree(),
        &document.session_id,
        &document.revision,
        &Fixture::event_for(&document),
    );
    assert!(matches!(
        result,
        Err(CompanionError::Internal(message)) if message.contains("timed out")
    ));
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[test]
fn rejects_stale_session_or_revision() {
    let fixture = Fixture::new();
    fixture.active_session("123-456", "layout.html", b"screen");
    let document = current_bundle(fixture.worktree()).unwrap().unwrap();
    let event = Fixture::event_for(&document);

    assert_eq!(
        append_event(
            fixture.worktree(),
            "old-session",
            &document.revision,
            &event,
        ),
        Err(CompanionError::StaleRevision)
    );
    assert_eq!(
        append_event(
            fixture.worktree(),
            &document.session_id,
            "old-revision",
            &event,
        ),
        Err(CompanionError::StaleRevision)
    );
}

#[test]
fn rejects_invalid_or_oversized_events() {
    let fixture = Fixture::new();
    fixture.active_session("123-456", "layout.html", b"screen");
    let document = current_bundle(fixture.worktree()).unwrap().unwrap();
    let mut cases = Vec::new();

    let mut wrong_type = Fixture::event_for(&document);
    wrong_type.event_type = "submit".into();
    cases.push(wrong_type);
    let mut empty_choice = Fixture::event_for(&document);
    empty_choice.choice.clear();
    cases.push(empty_choice);
    let mut choice = Fixture::event_for(&document);
    choice.choice = "x".repeat(257);
    cases.push(choice);
    let mut element_id = Fixture::event_for(&document);
    element_id.element_id = Some("x".repeat(257));
    cases.push(element_id);
    let mut text = Fixture::event_for(&document);
    text.text = "x".repeat(4097);
    cases.push(text);
    let mut event_id = Fixture::event_for(&document);
    event_id.event_id = "x".repeat(129);
    cases.push(event_id);
    let mut serialized = Fixture::event_for(&document);
    serialized.text = "\\".repeat(4096);
    cases.push(serialized);

    for event in cases {
        assert_eq!(
            append_event(
                fixture.worktree(),
                &document.session_id,
                &document.revision,
                &event,
            ),
            Err(CompanionError::InvalidEvent)
        );
    }
}

#[cfg(unix)]
#[test]
fn rejects_a_workspace_path_replaced_during_event_validation() {
    let fixture = Fixture::new();
    fixture.active_session("123-456", "layout.html", b"screen");
    let document = current_bundle(fixture.worktree()).unwrap().unwrap();
    let departed = fixture.temp_dir.path().join("departed");
    let departed_events = departed.join(".superpowers/brainstorm/123-456/state/events");
    let mut resolution_count = 0;

    let result = append_event_with_workspace_resolver(
        || {
            resolution_count += 1;
            if resolution_count == 2 {
                std::fs::rename(fixture.worktree(), &departed).unwrap();
                std::fs::create_dir_all(fixture.worktree()).unwrap();
            }
            Ok(fixture.worktree().to_path_buf())
        },
        &document.session_id,
        &document.revision,
        &Fixture::event_for(&document),
    );

    assert_eq!(resolution_count, 2);
    assert_eq!(result, Err(CompanionError::StaleRevision));
    assert!(!departed_events.exists());
}

#[cfg(unix)]
#[test]
fn rejects_an_old_click_when_a_new_revision_publishes_during_append() {
    let fixture = Fixture::new();
    fixture.active_session("123-456", "layout.html", b"old screen");
    let document = current_bundle(fixture.worktree()).unwrap().unwrap();
    let event = Fixture::event_for(&document);
    let document_path = fixture.session_path("123-456").join("content/layout.html");
    let mut resolution_count = 0;

    let result = append_event_with_workspace_resolver(
        || {
            resolution_count += 1;
            if resolution_count == 3 {
                std::fs::write(&document_path, b"new screen").unwrap();
            }
            Ok(fixture.worktree().to_path_buf())
        },
        &document.session_id,
        &document.revision,
        &event,
    );

    assert_eq!(result, Err(CompanionError::StaleRevision));
    let current = current_bundle(fixture.worktree()).unwrap().unwrap();
    assert_ne!(current.revision, event.revision);
    let written =
        std::fs::read_to_string(fixture.session_path("123-456").join("state/events")).unwrap();
    let durable: CompanionEvent = serde_json::from_str(written.trim()).unwrap();
    assert_eq!(durable.session_id, event.session_id);
    assert_eq!(durable.revision, event.revision);
    assert_ne!(durable.revision, current.revision);
}

#[cfg(unix)]
#[test]
fn rejects_state_directory_swaps_before_and_after_the_event_write() {
    for swap_resolution in [2, 3] {
        let fixture = Fixture::new();
        fixture.active_session("123-456", "layout.html", b"screen");
        let document = current_bundle(fixture.worktree()).unwrap().unwrap();
        let state = fixture.session_path("123-456").join("state");
        let departed_state = fixture
            .temp_dir
            .path()
            .join(format!("departed-state-{swap_resolution}"));
        let mut resolution_count = 0;

        let result = append_event_with_workspace_resolver(
            || {
                resolution_count += 1;
                if resolution_count == swap_resolution {
                    std::fs::rename(&state, &departed_state).unwrap();
                    std::fs::create_dir(&state).unwrap();
                    std::fs::write(state.join("server-info"), b"{}").unwrap();
                }
                Ok(fixture.worktree().to_path_buf())
            },
            &document.session_id,
            &document.revision,
            &Fixture::event_for(&document),
        );

        assert_eq!(result, Err(CompanionError::StaleRevision));
        assert_eq!(resolution_count, swap_resolution);
        assert!(!state.join("events").exists());
        assert_eq!(departed_state.join("events").exists(), swap_resolution == 3);
    }
}

#[cfg(unix)]
#[test]
fn rejects_an_event_file_swap_after_the_event_write() {
    let fixture = Fixture::new();
    fixture.active_session("123-456", "layout.html", b"screen");
    let document = current_bundle(fixture.worktree()).unwrap().unwrap();
    let events = fixture.session_path("123-456").join("state/events");
    let departed_events = fixture.temp_dir.path().join("departed-events");
    let mut resolution_count = 0;

    let result = append_event_with_workspace_resolver(
        || {
            resolution_count += 1;
            if resolution_count == 3 {
                std::fs::rename(&events, &departed_events).unwrap();
                std::fs::write(&events, b"").unwrap();
            }
            Ok(fixture.worktree().to_path_buf())
        },
        &document.session_id,
        &document.revision,
        &Fixture::event_for(&document),
    );

    assert_eq!(result, Err(CompanionError::StaleRevision));
    assert_eq!(resolution_count, 3);
    assert_eq!(std::fs::read(&events).unwrap(), b"");
    assert_eq!(
        std::fs::read_to_string(departed_events)
            .unwrap()
            .lines()
            .count(),
        1
    );
}

#[cfg(unix)]
#[test]
fn refuses_a_symlinked_event_target() {
    let fixture = Fixture::new();
    fixture.active_session("123-456", "layout.html", b"screen");
    let document = current_bundle(fixture.worktree()).unwrap().unwrap();
    let outside = fixture.temp_dir.path().join("outside-events");
    std::fs::write(&outside, "untouched\n").unwrap();
    std::os::unix::fs::symlink(
        &outside,
        fixture.session_path("123-456").join("state/events"),
    )
    .unwrap();

    assert!(matches!(
        append_event(
            fixture.worktree(),
            &document.session_id,
            &document.revision,
            &Fixture::event_for(&document),
        ),
        Err(CompanionError::Internal(_))
    ));
    assert_eq!(std::fs::read_to_string(outside).unwrap(), "untouched\n");
}

#[cfg(unix)]
#[test]
fn refuses_a_hardlinked_event_target_without_modifying_its_target() {
    let fixture = Fixture::new();
    fixture.active_session("123-456", "layout.html", b"screen");
    let document = current_bundle(fixture.worktree()).unwrap().unwrap();
    let outside = fixture.temp_dir.path().join("outside-events");
    let original = b"must remain untouched\n";
    std::fs::write(&outside, original).unwrap();
    std::fs::hard_link(
        &outside,
        fixture.session_path("123-456").join("state/events"),
    )
    .unwrap();

    assert!(matches!(
        append_event(
            fixture.worktree(),
            &document.session_id,
            &document.revision,
            &Fixture::event_for(&document),
        ),
        Err(CompanionError::Internal(message)) if message.contains("unsafe identity")
    ));
    assert_eq!(std::fs::read(outside).unwrap(), original);
}

#[cfg(unix)]
#[test]
fn refuses_a_fifo_event_target_promptly_without_writing() {
    use std::io::Read as _;
    use std::os::unix::ffi::OsStrExt as _;
    use std::os::unix::fs::OpenOptionsExt as _;
    use std::sync::mpsc;

    let fixture = Fixture::new();
    fixture.active_session("123-456", "layout.html", b"screen");
    let document = current_bundle(fixture.worktree()).unwrap().unwrap();
    let events_path = fixture.session_path("123-456").join("state/events");
    let fifo_path = std::ffi::CString::new(events_path.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo_path.as_ptr(), 0o600) }, 0);

    let worktree = fixture.worktree().to_path_buf();
    let event = Fixture::event_for(&document);
    let session_id = document.session_id;
    let revision = document.revision;
    let (result_tx, result_rx) = mpsc::channel();
    let append = std::thread::spawn(move || {
        let result = append_event(&worktree, &session_id, &revision, &event);
        result_tx.send(result).unwrap();
    });

    let prompt_result = result_rx.recv_timeout(Duration::from_millis(250));
    let returned_promptly = prompt_result.is_ok();
    let mut reader = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(&events_path)
        .unwrap();
    let append_result = match prompt_result {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => result_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("opening a FIFO reader should release a blocking writer"),
        Err(error) => panic!("visual companion append channel failed: {error}"),
    };
    append.join().unwrap();
    let mut written = Vec::new();
    reader.read_to_end(&mut written).unwrap();

    assert!(
        returned_promptly,
        "append_event blocked while opening an untrusted FIFO"
    );
    assert!(matches!(append_result, Err(CompanionError::Internal(_))));
    assert!(
        written.is_empty(),
        "append_event wrote into an untrusted FIFO"
    );
}
