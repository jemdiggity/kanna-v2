import { ref, type Ref } from "vue";
import type { DbHandle } from "@kanna/db";
import { getSetting, setSetting } from "@kanna/db";

export function usePreferences(db: Ref<DbHandle | null>) {
  const fontFamily = ref("SF Mono, Fira Code, Cascadia Code, Menlo, monospace");
  const fontSize = ref(13);
  const suspendAfterMinutes = ref(30);
  const killAfterMinutes = ref(60);
  const appearanceMode = ref<"dark" | "light" | "system">("dark");
  const ideCommand = ref("code");

  async function load() {
    if (!db.value) return;
    const ff = await getSetting(db.value, "fontFamily");
    if (ff) fontFamily.value = ff;
    const fs = await getSetting(db.value, "fontSize");
    if (fs) fontSize.value = parseInt(fs, 10) || 13;
    const sa = await getSetting(db.value, "suspendAfterMinutes");
    if (sa) suspendAfterMinutes.value = parseInt(sa, 10) || 30;
    const ka = await getSetting(db.value, "killAfterMinutes");
    if (ka) killAfterMinutes.value = parseInt(ka, 10) || 60;
    const am = await getSetting(db.value, "appearanceMode");
    if (am === "dark" || am === "light" || am === "system") {
      appearanceMode.value = am;
    }
    const ide = await getSetting(db.value, "ideCommand");
    if (ide) ideCommand.value = ide;
  }

  async function save(key: string, value: string) {
    if (!db.value) return;
    await setSetting(db.value, key, value);
    await load();
  }

  return {
    fontFamily,
    fontSize,
    suspendAfterMinutes,
    killAfterMinutes,
    appearanceMode,
    ideCommand,
    load,
    save,
  };
}
