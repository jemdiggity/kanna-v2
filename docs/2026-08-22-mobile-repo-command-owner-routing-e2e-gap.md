# Mobile repo-command owner-routing E2E gap

2026-08-22. Written with the fix for a successfully created repository-command task being loaded through the wrong paired desktop.

## Covered behavior

Server API tests assert that a successful command launch returns the creating desktop id, local repository id, and local task id. Mobile controller and transport tests cover bounded direct-task retries, accurate failure copy, and two paired desktops registering the same remote repository under different local ids and names; the task detail read is asserted against the desktop reported by the launch.

## Missing device-level proof

The current Appium fixtures cannot run one repository command through a real `kanna-server` while presenting two independently routed paired desktops with the same remote URL hash, nor delay only the new task's detail visibility. A device-level test needs a controllable multi-desktop relay/LAN fixture that can expose both inventories, record which server accepted the launch, and return temporary `404` responses for that server's new task. It can then assert that mobile retries only the accepting server and eventually opens the created task (or directs the operator to Tasks after the bounded retry window).
