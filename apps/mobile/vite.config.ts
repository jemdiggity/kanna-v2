import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// @ts-expect-error process is a nodejs global
const port = parseInt(process.env.KANNA_DEV_PORT || "1421", 10);

export default defineConfig(async () => ({
  plugins: [vue()],

  worker: {
    format: "es" as const,
  },

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@desktop": path.resolve(__dirname, "../desktop/src"),
      "@kanna/db/remote-db": path.resolve(__dirname, "../../packages/db/src/remote-db"),
      "@kanna/db": path.resolve(__dirname, "../../packages/db/src"),
      "@kanna/core": path.resolve(__dirname, "../../packages/core/src"),
    },
  },

  define: {
    __KANNA_MOBILE__: true,
  },

  build: {
    target: "esnext",
  },

  clearScreen: false,
  server: {
    port,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: port + 1 }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
