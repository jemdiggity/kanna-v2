import { invoke } from "../invoke";
import { resolveCurrentKannaServerBaseUrl } from "./kannaServerBaseUrl";

const LOCAL_SERVER_ACTION_TIMEOUT_MS = 30_000;
const LOCAL_SERVER_ACTION_RETRY_DELAY_MS = 250;

export type DesktopTaskAction = "advance-stage" | "rerun-stage" | "request-revision";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveLocalServerBaseUrl(): Promise<string> {
  const deadline = Date.now() + LOCAL_SERVER_ACTION_TIMEOUT_MS;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      await invoke("ensure_mobile_server");
      return await resolveCurrentKannaServerBaseUrl("resolving local task action server");
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("another kanna-server is already starting")) {
        throw error;
      }
      await sleep(LOCAL_SERVER_ACTION_RETRY_DELAY_MS);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError ?? "kanna-server did not become ready"));
}

export async function postDesktopTaskAction(
  taskId: string,
  action: DesktopTaskAction,
  body?: unknown,
): Promise<Response> {
  const serverBaseUrl = await resolveLocalServerBaseUrl();
  const url = `${serverBaseUrl}/v1/tasks/${encodeURIComponent(taskId)}/actions/${action}`;
  const deadline = Date.now() + LOCAL_SERVER_ACTION_TIMEOUT_MS;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      return await fetch(url, {
        method: "POST",
        ...(body == null
          ? {}
          : {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }),
      });
    } catch (error) {
      lastError = error;
      await sleep(LOCAL_SERVER_ACTION_RETRY_DELAY_MS);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError ?? `failed to call ${action}`));
}
