export const APP_READY_SCRIPT = `(() => {
  const hook = window.__KANNA_E2E__;
  return Boolean(hook?.ready);
})()`;

export const APP_DB_NAME_SCRIPT = `(() => {
  const hook = window.__KANNA_E2E__;
  return typeof hook?.dbName === "string" && hook.dbName.length > 0
    ? hook.dbName
    : null;
})()`;

/**
 * Clear the readiness flags, then reload.
 *
 * `location.reload()` returns before the navigation happens, so a bare
 * `waitForAppReady()` afterwards can observe the OUTGOING page's flags and
 * return while the old document is still up — the new page's startup then
 * lands mid-test, which is how a reload's first probe found no
 * `window.__KANNA_E2E__` at all.
 */
export const RELOAD_APP_SCRIPT = `if (window.__KANNA_E2E__) {
  window.__KANNA_E2E__.ready = false;
  window.__KANNA_E2E__.startupOverlaysSettled = false;
}
location.reload();`;
