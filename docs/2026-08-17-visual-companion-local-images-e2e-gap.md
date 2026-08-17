# Visual companion local images E2E gap (2026-08-17)

Task-authored companion documents can reference sibling images, which the
server prepares as bounded `data:` URLs before desktop or mobile delivery.
This crosses filesystem discovery, the KSP snapshot, the desktop browser
bridge, and the React Native WebView.

A real desktop/mobile end-to-end assertion is not added here because
`apps/desktop/tests/e2e/real/remote-visual-companion.test.ts` is part of the
known-red remote companion suite being rehabilitated separately. Depending on
that file would leave this fix without a causal signal until that work lands.

The gap can close when the remote companion E2E is reliable again and the
mobile harness can inspect the companion WebView. The fixture should author an
HTML gallery plus sibling PNGs, open it through both viewers, and assert the
images have non-zero rendered dimensions. It should also assert visible
placeholders for a traversal reference and a gallery over the inline budget.

Coverage landed meanwhile:

- Rust scanner tests prove relative and `/files/` references become data URLs,
  traversal and symlink references never read outside content, and oversized
  images become reason-bearing placeholders.
- A `kanna-server` scan test proves the assetless scan path used by KSP returns
  prepared sibling image data in the HTML bundle.
- Shared document-render tests execute the sanitizer for both desktop and
  React Native targets, proving prepared images survive and unprepared unsafe
  sources become visible placeholders.
- Existing mobile document and modal tests exercise the React Native document
  builder and WebView boundary independently of the known-red desktop E2E.
