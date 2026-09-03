# Mobile archive provenance E2E gap — 2026-09-03

`kd mobile archive --production` now pushes an annotated git tag containing
the archive's source, runtime, marketing version, and build number before any
optional App Store upload. The live archive-to-tag path is not run in automated
E2E because it requires a macOS signing session, an Apple Distribution
identity/provisioning access, a full Expo prebuild, and an Xcode device archive.
There is no isolated Apple signing sandbox for this operation.

The narrower `tools/kd/src/runtime/mobile-archive.test.ts` coverage exercises
the complete command orchestration with filesystem output and injected Xcode
process boundaries. Its Git integration case creates disposable real working
and bare remote repositories and real annotated/lightweight tag objects. It
proves that a valid existing annotation is reused and pushed without rewriting
its object, while lightweight, malformed-JSON, and same-commit mismatched
annotations stop before push or upload. Other archive tests cover source
resolution, dirty-tree refusal, runtime/build plan data, artifact reuse, and
source-commit mismatches.

The remaining gap can close when CI has an isolated macOS signing identity and
a disposable App Store app/team target. The E2E should run the real `./kd
mobile archive` Xcode build/export against that target, inspect the exported
IPA with `./kd mobile verify --ipa`, and exercise a sandboxed upload. The Git
annotated-tag object/content and remote-push boundary no longer depends on that
future infrastructure.
