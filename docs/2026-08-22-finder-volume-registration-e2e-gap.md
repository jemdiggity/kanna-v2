# Finder volume-registration preflight E2E gap

The macOS DMG builder now attaches a scratch HFS+ image and asks Finder for the
new disk before attempting the real Finder layout. Unit coverage proves the
scratch-image lifecycle, the AppleScript query, cleanup, and the actionable
error shown when Finder returns `-1728`.

An automated E2E cannot currently prove the failure path because it requires a
real logged-in macOS GUI session whose Finder process is deliberately placed in
the wedged state where newly attached volumes are absent from Finder's object
model. The existing Bazel release environment has no supported way to induce
and restore that Finder-global state without disrupting the operator's desktop.

Close this gap when the macOS GUI test harness can run in an isolated user
session or VM and can deterministically suspend Finder volume registration.
That test should attach the scratch image, reproduce `-1728`, assert the
`killall Finder` guidance, relaunch Finder, and prove a subsequent preflight
succeeds.
