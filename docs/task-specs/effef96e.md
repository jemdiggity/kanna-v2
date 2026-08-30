# Modal tear-off

Owner request (2026-08-27, verbatim): “for the desktop app, most of the ancillary features (file explorer, diff tool) use modals. as agents get smarter and smarter, the human only needs to check what the agent is doing and then close the modal, but I think we need a middle ground where the modals can persist longer while not blocking the main UI. I suggest that the user be able to drag the modal and then it would turn into a window instance with that modal opened when the user releases the drag. the new window is the same size as the modal and the modal takes up the full size of the window (which is the same size it was before being dragged). the idea is to let users investigate the source files or diff while the agent is working on something...”

## Goal and scope

Add a reusable desktop modal tear-off gesture for the file explorer (`TreeExplorerModal`, including its file-preview flow) and diff modal. Dragging non-interactive header/chrome beyond a small threshold immediately creates a real Tauri webview window with the modal's current size and full-window content, closes the originating modal so the main UI and terminal are usable, and hands the continuing gesture to native window dragging. The new window is independently movable, resizable, and closable. Dismissing its explorer or diff surface leaves that same OS window open as an ordinary Kanna workspace.

Each tear-off is a fresh Vue app instance bootstrapped from serialized surface context (paths/task and diff refs plus cheap view state). It does not DOM-reparent. It uses the persisted window workspace registry and the same create/geometry/close lifecycle as ordinary app windows. The ordinary `App.vue` bootstrap restores the copied selection and opens the transferred surface through the standard modal layer in maximized state.

Owner clarification (2026-08-27): “i think it's okay if the tear-offs use the same new window functionality.” Tear-offs therefore reuse the existing Tauri app-window creation lifecycle.

Owner directive (2026-08-27): “it's fine if they persist. I think the task manager was trying to make it easier for you. But they've over-defined the scope and make it restrictive for no reason.” This replaces the manager-added no-restart-persistence restriction: torn-off surfaces may participate in the same persisted window workspace lifecycle as ordinary Kanna windows and restore after restart.

Owner revision (2026-08-28, verbatim): “I tried it out. Let's make the modal -> new window transition happen when the drag starts and just make it a normal window. For example, if you drag the tree explorer and make a new window, you can then exit out of the tree explorer and it's a normal window.” This replaces release-to-create behavior: crossing the drag threshold creates the native window immediately and hands the continuing drag to it. The detached surface initially fills that window; dismissing the surface converts the same OS window into an ordinary Kanna workspace rather than closing it. Closing the OS window itself remains an independent window close.

Owner clarification (2026-08-29, verbatim): “I want the newly created window to behave a little differently. for example, if you're viewing the file explorer as a modal and then drag it, it should make a new window with the file explorer modal (or whatever was previously the modal being viewed) maximized, but it should still behave the same way as if you created a new window and maximized the modal. you should be able to close the modal in the new window and use it like a normally created window. do you understand?” This replaces the special standalone-surface bootstrap and later promotion/reload: the new webview runs the ordinary Kanna app from its first render, with the transferred modal opened through its normal modal layer in maximized state. Closing that modal reveals the already-running ordinary workspace beneath it without reloading the window.

Owner refinement (2026-08-29, verbatim): “pretty good. make sure it doesn't try to display the shortcut menu over top of the modal we've expanded into its new window” The automatic startup shortcuts prompt is suppressed when a window boots with a transferred modal, so the maximized explorer or diff remains the topmost initial surface. The normal explicit shortcut-menu command remains available.

Owner polish directive (2026-08-29, verbatim): “can we not show the big hand cursor and just keep the normal cursor” Tear-off header/chrome retains the normal arrow cursor; the drag gesture and threshold remain unchanged.

## Constraints and exclusions

- Shell/terminal modals have no tear-off affordance in v1; KeepAlive/xterm and a second PTY consumer need a separate design.
- Shell/terminal persistence remains out because restoring xterm/PTY attachment is the same unresolved second-consumer design, not because persistence is generally prohibited.
- Existing file/diff components are reused in full-window mode; adding another surface should require a context variant and renderer wiring, not a new window mechanism.
- Diff rendering continues to use `containerWrapper`, `worker-portable.js`, and worker-pool theme/line-diff options in each webview.
- Do not refactor unrelated modal code.

## Done when

Both surfaces pass focused component/logic coverage and either a real multi-window WebDriver E2E or a dated E2E-gap note; TypeScript and `./kd test all` are clean; and the real desktop app has been visually exercised for threshold behavior, immediate creation/native drag handoff, placement/size, both surfaces, resize/reflow, persistence, ordinary-app modal behavior without reload, independent close, and continued main-terminal usability, with screenshots saved under `docs/task-specs/effef96e-screenshots/` (gitignored). This manual stage then pauses for owner on-machine feel testing.

## Verification record

Verified 2026-08-27 (superseded release-to-create interaction):

- The focused Vitest suites, `vue-tsc --noEmit`, the Kanna server window-workspace tests, workspace Clippy, and `./kd test all` pass. Clippy reports only pre-existing warnings outside this change.
- `tauri-plugin-webdriver` multi-window E2E passes for both surfaces: sub-threshold drag, release-derived position and exact modal content size, full-window content, resize/reflow, nested file preview, source UI unblocking, persisted workspace membership, and independent close/removal.
- `./kd dev up` real-app renders were exercised and inspected at original and resized dimensions for both surfaces; screenshots are under `docs/task-specs/effef96e-screenshots/`. The seeded demo records use placeholder filesystem paths, so these screenshots intentionally show the surfaces' error states; the WebDriver fixture separately verifies real file and diff content.
- The dev app, sidecars, and daemon were stopped after verification. Owner on-machine gesture/polish approval remains the required next step before review.

Verified 2026-08-28 after the owner revision (superseded standalone-surface bootstrap):

- The full desktop Vitest suite passes (185 files, 1,738 tests), as do both desktop TypeScript checks, the Kanna server window-workspace tests, workspace Clippy, formatting, and `./kd test all`. Clippy reports only pre-existing warnings outside this change.
- The debug `tauri-plugin-webdriver` multi-window E2E passes twice for both surfaces. It covers sub-threshold cancellation, window creation as soon as the threshold is crossed, exact initial content size, full-window explorer and diff content, source-window unblocking, persisted workspace membership, resize/reflow, dismissal that clears the tear-off context while retaining the same secondary window as a normal Kanna app, and independent close.
- Real debug-app screenshots were captured and inspected at `docs/task-specs/effef96e-screenshots/file-explorer-tearoff-revised.png`, `file-explorer-promoted-window.png`, `diff-tearoff-revised.png`, and `diff-promoted-window.png`. They show real fixture content filling each tear-off and the same secondary window rendering the ordinary Kanna workspace after surface dismissal.
- Synthetic WebDriver pointer input cannot assess the feel of macOS's native `startDragging` handoff. The revised gesture therefore remains at this manual stage for the owner to retest on-machine before review. All debug-app processes, sidecars, and the daemon were stopped after verification.

Verified 2026-08-29 after the ordinary-window clarification:

- Focused modal, keyboard, lifecycle, workspace, and server tests pass; the full desktop suite passes (185 files, 1,740 tests); both TypeScript checks and formatting pass; and `./kd test all` reports canonical local verification clean. Existing unrelated compiler warnings remain unchanged.
- The debug `tauri-plugin-webdriver` multi-window E2E passes twice for both surfaces. It proves each secondary webview contains the ordinary `.app` plus the standard maximized modal, retains exact modal-sized content and reflow, and reveals the existing main workspace after modal dismissal without a reload (verified by a per-webview identity marker). Persisted transfer context is cleared while the secondary window remains independently usable and closable.
- Screenshots captured and inspected under the gitignored evidence directory: `file-explorer-normal-window-maximized.png`, `file-explorer-normal-window-closed.png`, `diff-normal-window-maximized.png`, and `diff-normal-window-closed.png`. They show real fixture content in the maximized standard modals and the ordinary sidebar/main workspace beneath each after closing.
- Synthetic WebDriver pointer input still cannot assess the feel of macOS's native `startDragging` handoff. The work remains at this manual stage for owner on-machine testing.

Owner on-machine verification (2026-08-30, relayed verbatim): “I tested it and it works ok”. The owner exercised the modal tear-off interaction in the dev desktop and approved it with no further polish requested. This satisfies the required human on-device testing gate for the UI-feel change and clears the task to proceed to review.
