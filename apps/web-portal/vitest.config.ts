import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";
import { sharedTestOptions } from "../../vitest.shared";

export default defineConfig({
  plugins: [vue()],
  test: {
    ...sharedTestOptions,
    environment: "happy-dom"
  }
});
