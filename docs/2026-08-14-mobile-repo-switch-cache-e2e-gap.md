# Mobile Repo Switch Cache E2E Gap

The mobile task list now projects a newly selected repository immediately from
the already-loaded all-open-task snapshot while its repo-specific refresh is
still pending. This removes the transient empty state between tapping a repo
chip and receiving the refresh response.

The Appium harness cannot currently delay and release a repo-task request at a
deterministic boundary. Without that gate, a device assertion cannot distinguish
an immediate cache projection from a fast Firestore, relay, or LAN response and
would race the transient state it is intended to detect.

Deterministic device coverage requires an E2E-only request gate that can pause
`listRepoTasks` after the all-repo snapshot is visible, expose that paused state
to the runner, and release the response after Appium verifies the next repo's
cached task row is visible and `No tasks yet.` never appears.

Until then, `apps/mobile/src/navigation/RootNavigator.integration.test.tsx`
drives the real repo chip through the controller and session store into the real
task list while holding the repo refresh promise unresolved. The narrower
controller test separately verifies that the delayed response still replaces
the cached slice when it arrives.
