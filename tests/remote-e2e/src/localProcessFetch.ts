import { request } from "node:http";

export type LocalProcessFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** HTTP client for loopback calls made with local-process authority. */
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
        const responseBody = status === 204 || status === 205 || status === 304
          ? null
          : Buffer.concat(chunks);
        resolve(new Response(responseBody, {
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
