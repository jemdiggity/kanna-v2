import { createApp } from "vue";
import { createPinia } from "pinia";
import type { DbHandle } from "@kanna/db";

declare global {
  const __KANNA_MOBILE__: boolean;
}

// Stub DB — all queries return empty results
const db: DbHandle = {
  async execute(): Promise<{ rowsAffected: number }> {
    return { rowsAffected: 0 };
  },
  async select<T>(): Promise<T[]> {
    return [];
  },
};

// Import App from desktop — shared Vue components
// __KANNA_MOBILE__ gates desktop-only features
import App from "@desktop/App.vue";

const app = createApp(App);
app.use(createPinia());
app.provide("db", db);
app.provide("dbName", "mobile");
app.mount("#app");
