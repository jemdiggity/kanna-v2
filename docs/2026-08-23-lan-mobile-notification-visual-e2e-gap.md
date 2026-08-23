# LAN mobile notification visual E2E gap

The foreground LAN notification banner and haptic cannot yet be driven by the
mobile simulator E2E harness. The real LAN-layer E2E stops at the shared mobile
transport callback, while the simulator harness has no control that injects a
server-originated KSP notification into an already paired app. The current
canonical `./kd mobile run` installer is physical-device-only; the booted
simulator's installed runtime also predates the new `expo-notifications` and
`expo-haptics` native modules, so loading this JS against it would not be an
honest verification of the new runtime.

The narrower coverage added meanwhile verifies the rendered banner copy and
actions as a component, foreground haptic versus background local scheduling
as notification lifecycle logic, and a real server + paired LAN stream through
the mobile transport callback. A full visual E2E becomes possible when the
simulator harness can pair with its worktree desktop and trigger
`POST /v1/mobile/notifications` after launch, or when `kd mobile run` supports
building and installing the current runtime on a simulator.
