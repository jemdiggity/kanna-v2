import { isTauri, mockListen } from "./tauri-mock";

export const listen: (event: string, handler: (event: any) => void) => Promise<() => void> =
  isTauri
    ? (await import("@tauri-apps/api/event")).listen
    : mockListen;
