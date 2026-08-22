# Mobile repository explorer WebView E2E gap (2026-08-22)

The repository explorer's native React Native ↔ WebView scroll/message boundary cannot currently be driven by the local Vitest tier: `react-native-webview` is mocked there, and the existing mobile device E2E harness does not expose WebView DOM inspection or synthetic high-velocity scrolling.

The narrower executable coverage runs the generated viewer document in a DOM, verifies a fixed 90-row window for a multi-million-line file, scrolls away and back to prove loitered content cache reuse, and selects a row to verify its absolute line reference. The loiter loader test proves repeated fling viewport messages produce no content request until settling, exactly one settled request, and reuse of an already-loaded range. A separate range-consumer test reconstructs a byte-chunked oversized line.

Closing this gap requires the device E2E harness to add WebView context switching (or a test-only message bridge) with DOM row-count inspection and controllable scroll/fling events. That test should assert the live `.line` count remains at most 90, fling messages do not trigger content reads, settling triggers one read, returning to the range reuses cache, and selecting a visible row emits its absolute `path:line` reference.
