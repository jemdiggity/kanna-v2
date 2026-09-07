import { request } from "node:http";

export type LocalProcessFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * HTTP client for loopback calls to `kanna-server` made with local-process
 * authority.
 *
 * `kanna-server` classifies every request on its real listener
 * (`crates/kanna-server/src/http_api/lan_trust.rs`): one carrying `Origin` or
 * any `Sec-Fetch-*` header is browser-originated and must present this
 * desktop's local control credential, while one carrying neither keeps the
 * loopback authority a process running as the user already holds.
 *
 * Node's global `fetch` is undici, which attaches `Sec-Fetch-Mode` to every
 * request it sends. So a Node test harness — an ordinary local process — is
 * classified as a browser and refused 403, even though nothing about it is a
 * browser. `node:http` sends only the headers it is handed, which is what this
 * client is: the same `fetch` shape, minus the browser costume.
 *
 * Use this for any HTTP call a test or harness makes to a Kanna server. Calls
 * to genuinely foreign services (Firebase emulators, Appium, Metro, the relay,
 * WebDriver) keep the global `fetch`; nothing there reads fetch metadata.
 * `packages/local-process-fetch/src/kannaTestFetch.contract.test.ts` enforces
 * that split.
 */
/**
 * Statuses the `Response` constructor refuses to pair with a body — it throws
 * `Invalid response status code`, turning a perfectly good `204 No Content`
 * into a client-side crash. `kanna-server` answers 204 from several action
 * routes, so this is not a corner case.
 */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

export const localProcessFetch: LocalProcessFetch = async (input, init = {}) => {
  const url = input instanceof URL ? input : new URL(input);
  if (url.protocol !== "http:") {
    throw new Error(`localProcessFetch only supports http URLs, received ${url.protocol}`);
  }
  const body = init.body;
  if (body != null && typeof body !== "string" && !(body instanceof Uint8Array)) {
    throw new Error("localProcessFetch only supports string or Uint8Array request bodies");
  }

  return await new Promise<Response>((resolve, reject) => {
    const clientRequest = request(url.toString(), {
      method: init.method ?? "GET",
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      signal: init.signal ?? undefined
    }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.once("error", reject);
      incoming.once("end", () => {
        const responseHeaders = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          responseHeaders.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
        }
        const status = incoming.statusCode ?? 500;
        resolve(new Response(NULL_BODY_STATUSES.has(status) ? null : Buffer.concat(chunks), {
          status,
          statusText: incoming.statusMessage,
          headers: responseHeaders
        }));
      });
    });
    clientRequest.once("error", reject);
    if (body != null) clientRequest.write(body);
    clientRequest.end();
  });
};
