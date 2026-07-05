// Test preload: set up happy-dom globals for composable tests that need DOM APIs.
import { Window } from "happy-dom";

const win = new Window();
// @ts-ignore
globalThis.document = win.document;
// @ts-ignore
globalThis.window = win;
// @ts-ignore
globalThis.localStorage = win.localStorage;
// @ts-ignore — use happy-dom's Event so dispatchEvent instanceof check passes
globalThis.Event = win.Event;

import {
  setDesktopSnapshotFetcherForTests,
  setDesktopTaskActionForTests,
  setDesktopTaskCreatorForTests,
} from "../services/desktopServerClient";

setDesktopSnapshotFetcherForTests(async () => ({
  entries: [],
  taskBlockers: [],
  worktreePaths: {},
  settings: {},
}));

setDesktopTaskActionForTests(async () => {});
setDesktopTaskCreatorForTests(async (request) => ({
  taskId: `test-${Math.random().toString(16).slice(2, 10)}`,
  repoId: request.repoId,
  title: request.displayName ?? request.prompt,
  stage: "in progress",
  agentType: request.agentType ?? "pty",
  worktreePath: null,
}));
