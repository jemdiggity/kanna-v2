# Mobile OTA observation verification

The server test `mobile_build_report_over_http_is_authenticated_persisted_and_redacted`
uses a real HTTP listener: pair, inspect an unknown device, reject unauthenticated
and forged reports, accept a build report, reload its persisted record, read the
redacted inventory, reject relay impersonation and malformed data, then unpair
and verify removal. Mobile tests cover the client payload and graceful failure
against an older server. The kd publication test publishes through the command
executor with fixture cloud operations and an older paired-device observation,
asserting that successful publishing still reports drift. Pointer tests cover
historical runtime inventory; device tests cover unknown, mixed, stale, and
other-channel observations and applied-update confirmation.

A signed iOS installation → real desktop → authenticated GCS publication test
is not yet automated. It needs a reporting-capable signed binary and isolated
cloud bucket/credentials, plus a controllable native runtime and app relaunch.
Metro cannot prove which signed native runtime receives a real Expo update.
The narrower tests above establish the HTTP/persistence boundary and release
command behavior without publishing live artifacts. On-device rollout should
verify a fresh LAN build report, then a matching OTA id after application, and
a warning when publishing a different runtime. Existing older binaries cannot
receive this instrumentation from a newer-runtime OTA; their unknown reports
must remain visible until a compatible native installation is installed.
