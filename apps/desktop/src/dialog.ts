import { isTauri, mockDialogOpen } from "./tauri-mock";

export const open: (opts?: any) => Promise<string | null> =
  isTauri
    ? (await import("@tauri-apps/plugin-dialog")).open
    : mockDialogOpen;
