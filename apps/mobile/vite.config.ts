import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// @ts-expect-error process is a nodejs global
const port = parseInt(process.env.KANNA_DEV_PORT || "1421", 10);
// @ts-expect-error process is a nodejs global
const relayPort = process.env.KANNA_RELAY_PORT || "9080";

export default defineConfig(async () => ({
  plugins: [vue()],

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },

  define: {
    __KANNA_RELAY_URL__: JSON.stringify(
      host ? `ws://${host}:${relayPort}` : `ws://localhost:${relayPort}`,
    ),
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
