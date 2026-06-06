import { setTheme } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "../tauri-mock";
import type { ResolvedTheme } from "./theme";

export type NativeAppTheme = ResolvedTheme | null;

export async function syncNativeAppTheme(theme: NativeAppTheme): Promise<void> {
  if (!isTauri) return;

  await Promise.all([
    setTheme(theme),
    getCurrentWindow().setTheme(theme),
  ]);
}
