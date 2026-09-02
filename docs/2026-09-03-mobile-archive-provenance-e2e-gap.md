# Mobile archive provenance E2E gap — 2026-09-03

`kd mobile archive --production` now pushes an annotated git tag containing
the archive's source, runtime, marketing version, and build number before any
optional App Store upload. The live archive-to-tag path is not run in automated
E2E because it requires a macOS signing session, an Apple Distribution
identity/provisioning access, a full Expo prebuild, and an Xcode device archive.
There is no isolated Apple signing sandbox for this operation.

The narrower `tools/kd/src/runtime/mobile-archive.test.ts` coverage exercises
the complete command orchestration with filesystem output and injected process
boundaries. It asserts that the annotated tag contains every required field,
is pushed to `origin`, and is recorded before the uploader can run. Existing
archive tests cover source resolution, dirty-tree refusal, runtime/build plan
data, artifact reuse, and source-commit mismatches.

This gap can close when CI has an isolated macOS signing identity and a
throwaway remote repository. The E2E should run the real `./kd mobile archive`
against a disposable app/team target, inspect the exported IPA with
`./kd mobile verify --ipa`, clone the remote afresh, and assert the pushed tag's
peeled commit and JSON message before enabling a fake uploader.
