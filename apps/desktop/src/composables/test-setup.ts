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
  setDesktopServerClientHandlersForTests,
  setDesktopSnapshotFetcherForTests,
} from "../services/desktopServerClient";

setDesktopSnapshotFetcherForTests(async () => ({
  entries: [],
  taskBlockers: [],
  worktreePaths: {},
  settings: {},
}));

setDesktopServerClientHandlersForTests({
  getSetting: async () => null,
  putSetting: async (key, value) => ({ key, value }),
  postOperatorEvents: async () => {},
  fetchRepoAnalytics: async () => ({
    taskBuckets: [],
    bucketSize: "daily",
    hasData: false,
    avgTimeInState: {
      working: 0,
      idle: 0,
      unread: 0,
    },
    operatorMetrics: {
      avgResponseTime: null,
      avgDwellTime: null,
      switchesPerHour: null,
      focusScore: null,
    },
    hasOperatorData: false,
  }),
  patchRepo: async () => {},
  putTaskAgentSession: async () => {},
  fetchPendingIncomingTransfers: async () => [],
  claimPendingIncomingTransfer: async () => false,
  failPendingIncomingTransfer: async () => false,
  fetchClosedTaskIdentities: async () => [],
});
