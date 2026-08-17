# Mobile quick-reply recovery and E2E coverage

The mobile quick-reply repository stores its active envelope at
`kanna.mobile.quick-replies.v1`. Before a successful save overwrites that
envelope, it rotates the previous validated envelope to
`kanna.mobile.quick-replies.backup.v1` (one generation). If the active payload
cannot be parsed, has an unsupported version, or normalizes to an empty list,
the untouched raw payload is copied to
`kanna.mobile.quick-replies.recovery.v1`.

The app exposes no arbitrary AsyncStorage test or restore surface. Adding one
only for automation would create a production data-mutation interface, so the
failure and recovery wiring is covered at the repository and mounted-App
levels instead:

- corrupt, empty-normalized, and future-version payload preservation;
- refused saves after failed or unresolved loads;
- explicit replacement confirmation and the visible load-failure notice;
- last-good backup rotation before the active write;
- full-list editor saves after a loaded baseline.

The existing relay device journey still covers the production UI boundary for
editing, saving, process relaunch, reloading, and drag-sending a customized
reply. A device-level corrupt-payload case becomes appropriate if Kanna gains a
supported diagnostics/restore UI that can inspect or restore these keys; that
surface can seed the incident without a test-only storage backdoor.
