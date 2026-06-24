import type { CurrentUpdateInfo } from "../lib/updates/otaUpdates";

export interface UpdateInfoRow {
  label: string;
  value: string;
}

export function buildUpdateInfoRows(info: CurrentUpdateInfo): UpdateInfoRow[] {
  return [
    { label: "OTA", value: info.enabled ? "enabled" : "disabled" },
    { label: "Channel", value: info.channel ?? "none" },
    { label: "Runtime", value: info.runtimeVersion ?? "unknown" },
    { label: "Update", value: info.updateId ? info.updateId.slice(0, 8) : "embedded" }
  ];
}
