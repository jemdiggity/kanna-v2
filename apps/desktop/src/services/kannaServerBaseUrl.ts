import { invoke } from "../invoke";
import { resolveKannaServerBaseUrl } from "../stores/kannaCliEnv";

interface MobileServerStatusResponse {
  lanPort?: number | string | null;
  lan_port?: number | string | null;
}

export async function resolveCurrentKannaServerBaseUrl(logContext: string): Promise<string> {
  const status = await invoke<MobileServerStatusResponse>("mobile_server_status").catch((error) => {
    console.debug(`[runtime] mobile_server_status not available while ${logContext}:`, error);
    return null;
  });
  const statusPort = status?.lanPort ?? status?.lan_port;
  if (statusPort !== undefined && statusPort !== null && String(statusPort).trim().length > 0) {
    return resolveKannaServerBaseUrl(String(statusPort));
  }

  const mobileServerPort = await invoke<string>("read_env_var", { name: "KANNA_MOBILE_SERVER_PORT" }).catch((error) => {
    console.debug(`[runtime] KANNA_MOBILE_SERVER_PORT not set while ${logContext}:`, error);
    return null;
  });
  return resolveKannaServerBaseUrl(mobileServerPort);
}

export function streamUrlFromServerBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/v1/stream";
  url.search = "";
  url.hash = "";
  return url.toString();
}
