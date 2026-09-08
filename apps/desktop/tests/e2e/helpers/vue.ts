/**
 * Vue state helpers — access App.vue's setupState via WebDriver JS execution.
 * Only works in dev builds where Kanna exposes window.__KANNA_E2E__.
 */
import { WebDriverClient } from "./webdriver";

const CTX = 'window.__KANNA_E2E__.setupState';

/** Read a setupState property, auto-unwrapping Vue refs. */
export async function getVueState(
  client: WebDriverClient,
  prop: string
): Promise<unknown> {
  return client.executeSync(
    `const ctx = ${CTX};
     const storeVal = ctx.store ? ctx.store[${JSON.stringify(prop)}] : undefined;
     const val = storeVal !== undefined ? storeVal : ctx.${prop};
     const unwrapped = val && val.__v_isRef ? val.value : val;
     // JSON round-trip to strip Vue reactive proxies
     try { return JSON.parse(JSON.stringify(unwrapped)); } catch { return unwrapped; }`
  );
}

/** Call a setupState method and return its result. */
export async function callVueMethod(
  client: WebDriverClient,
  method: string,
  ...args: unknown[]
): Promise<unknown> {
  const argsJson = JSON.stringify(args);
  return client.executeAsync(
    `const cb = arguments[arguments.length - 1];
     const ctx = ${CTX};
     const resolveMethod = (root, path) => {
       const parts = path.split(".");
       let parent = root;
       let value = root;
       for (const part of parts) {
         parent = value;
         value = value?.[part];
       }
       if (typeof value === "function") return value.bind(parent);
       return value;
     };
     const target =
       resolveMethod(ctx, ${JSON.stringify(method)}) ??
       resolveMethod(ctx.store ?? {}, ${JSON.stringify(method)});
     if (typeof target !== "function") {
       cb({ __error: "Method not found: " + ${JSON.stringify(method)} });
       return;
     }
     Promise.resolve(target(...${argsJson}))
       .then(r => {
         try { cb(JSON.parse(JSON.stringify(r))); } catch { cb(r ?? null); }
       })
       .catch(e => cb({ __error: e.message || String(e) }));`
  );
}

/** Execute a SELECT query through the Vue DB handle. */
export async function queryDb(
  client: WebDriverClient,
  sql: string,
  params: unknown[] = []
): Promise<unknown[]> {
  const paramsJson = JSON.stringify(params);
  return client.executeAsync(
    `const cb = arguments[arguments.length - 1];
     const ctx = ${CTX};
     const db = ctx.db.value || ctx.db;
     db.select(${JSON.stringify(sql)}, ${paramsJson})
       .then(r => cb(r))
       .catch(e => cb({ __error: e.message || String(e) }));`
  );
}

/** Execute a write query (INSERT/UPDATE/DELETE) through the Vue DB handle. */
export async function execDb(
  client: WebDriverClient,
  sql: string,
  params: unknown[] = []
): Promise<void> {
  const paramsJson = JSON.stringify(params);
  const result = await client.executeAsync(
    `const cb = arguments[arguments.length - 1];
     const ctx = ${CTX};
     const db = ctx.db.value || ctx.db;
     db.execute(${JSON.stringify(sql)}, ${paramsJson})
       .then(() => cb("ok"))
       .catch(e => cb({ __error: e.message || String(e) }));`
  );
  if (result && typeof result === "object" && "__error" in (result as any)) {
    throw new Error((result as any).__error);
  }
}

/** Invoke a Tauri command from the webview context. */
export async function tauriInvoke(
  client: WebDriverClient,
  cmd: string,
  args: Record<string, unknown> = {}
): Promise<unknown> {
  const argsJson = JSON.stringify(args);
  return client.executeAsync(
    `const cb = arguments[arguments.length - 1];
     window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${argsJson})
       .then(r => cb(r))
       .catch(e => cb({ __error: e.message || String(e) }));`
  );
}

/**
 * Open or close the Preferences view.
 *
 * Preferences is a tab in the main content area, not an overlay, so a test
 * that needs the account or mobile panel asks the tab set for it rather than
 * flipping a `showPreferencesPanel` flag that no longer exists.
 */
export async function setPreferencesOpen(
  client: WebDriverClient,
  open: boolean,
): Promise<void> {
  await client.executeSync(`
    const ctx = window.__KANNA_E2E__?.setupState;
    const tabs = ctx?.mainTabs;
    if (!tabs) throw new Error("main tabs are unavailable on setupState");
    const existing = (tabs.tabs?.value ?? []).find((tab) => tab.kind === "preferences");
    if (${open ? "true" : "false"}) {
      if (existing) tabs.activateTab(existing.id);
      else tabs.openTab({ kind: "preferences" });
    } else if (existing) {
      tabs.closeTab(existing.id);
    }
    return true;
  `);
}

/**
 * Close the main content area's tabs — every one, or just the kinds named.
 *
 * The views a test opens live in tabs now, so this is how a step resets the
 * main area between assertions instead of clearing a modal flag.
 */
export async function closeMainTabs(
  client: WebDriverClient,
  kinds?: string[],
): Promise<void> {
  await client.executeSync(`
    const tabs = window.__KANNA_E2E__?.setupState?.mainTabs;
    if (!tabs) throw new Error("main tabs are unavailable on setupState");
    const kinds = ${JSON.stringify(kinds ?? null)};
    for (const tab of [...(tabs.tabs?.value ?? [])]) {
      if (!kinds || kinds.includes(tab.kind)) tabs.closeTab(tab.id);
    }
    return true;
  `);
}

/**
 * The body of {@link closeMainTabs} as a script string, for call sites that
 * already pass raw scripts to `executeSync`.
 */
export function closeMainTabsScript(kinds?: string[]): string {
  return `
    const tabs = window.__KANNA_E2E__?.setupState?.mainTabs;
    if (!tabs) throw new Error("main tabs are unavailable on setupState");
    const kinds = ${JSON.stringify(kinds ?? null)};
    for (const tab of [...(tabs.tabs?.value ?? [])]) {
      if (!kinds || kinds.includes(tab.kind)) tabs.closeTab(tab.id);
    }
    return true;
  `;
}
