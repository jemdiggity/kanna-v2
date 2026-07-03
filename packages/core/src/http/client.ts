export interface HttpRequestOptions extends RequestInit {
  timeoutMs?: number;
}

export interface AssertOkOptions {
  includeBody?: boolean;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

function requestSignal(timeoutMs?: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
}

export async function httpRequest(
  input: RequestInfo | URL,
  options: HttpRequestOptions = {}
): Promise<Response> {
  const { timeoutMs, signal, ...fetchOptions } = options;
  return fetch(input, {
    ...fetchOptions,
    signal: signal ?? requestSignal(timeoutMs),
  });
}

export async function assertOk(
  response: Response,
  providerLabel: string,
  options: AssertOkOptions = {}
): Promise<void> {
  if (response.ok) return;

  if (options.includeBody) {
    const text = await response.text();
    throw new Error(`${providerLabel} error ${response.status}: ${text}`);
  }

  throw new Error(`${providerLabel} error ${response.status}`);
}
