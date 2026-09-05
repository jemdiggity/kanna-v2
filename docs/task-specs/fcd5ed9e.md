# Complete simulator evidence for task 594b800c

## Goal and scope

Complete the simulator-only verification that Studio task `594b800c` could not
run: capture the Account sheet with the custom relay card absent in staging and
present in dev, then replace the blocked-toolchain passage in
`docs/task-specs/594b800c.md` with the observed two-machine toolchain and render
record. Do not alter the already-implemented mobile behavior or widen scope.

## Constraints and done condition

Use `./kd mobile run --simulator` with an explicitly booted iOS 26.5 device.
Keep the change JS-only and every mobile `runtimeVersion` at `2.2.3`; do not
commit screenshot binaries. Done means both screenshots exist under the
gitignored `docs/task-specs/594b800c-screenshots/`, the transferred spec is
accurate, and mobile TypeScript plus unit tests pass.

## Verification result

On 2026-09-04, Xcode 26.6 (build 17F113) built both variants for an explicitly
booted iPhone 17 Pro on iOS 26.5 (build 23F77). The staging Account sheet had
no relay card, while the dev Account sheet showed the complete relay control;
the screenshot paths and toolchain comparison are recorded in the transferred
task spec. No implementation or native configuration was changed. Mobile
TypeScript passed, and Vitest passed 1,838 tests with 3 skipped.
