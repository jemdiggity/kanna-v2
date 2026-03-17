/**
 * Vue state helpers — access App.vue's setupState via WebDriver JS execution.
 * Only works in dev builds where Vue exposes __vue_app__._instance.setupState.
 */
import { WebDriverClient } from "./webdriver";

const CTX = 'document.getElementById("app").__vue_app__._instance.setupState';

/** Read a setupState property, auto-unwrapping Vue refs. */
export async function getVueState(
  client: WebDriverClient,
  prop: string
): Promise<unknown> {
  return client.executeSync(
    `const ctx = ${CTX};
     const val = ctx.${prop};
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
     Promise.resolve(ctx.${method}(...${argsJson}))
       .then(r => cb(r))
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
