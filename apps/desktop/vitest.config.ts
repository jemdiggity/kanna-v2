import { configDefaults, defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";
import path from "path";
import { sharedTestOptions } from "../../vitest.shared";

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@kanna/db": path.resolve(__dirname, "../../packages/db/src"),
      "@kanna/core": path.resolve(__dirname, "../../packages/core/src"),
    },
  },
  test: {
    ...sharedTestOptions,
    environment: "happy-dom",
    setupFiles: [...sharedTestOptions.setupFiles, "./src/composables/test-setup.ts"],
    // Driven suites need a running app and are launched through
    // `tests/e2e/run.ts` with `tests/e2e/vitest.config.ts`. Collecting them
    // from a bare `vitest run` only runs their setup/cleanup hooks against no
    // app — which is how fixture cleanup once ran with an unassigned repo path.
    // Harness unit tests under `tests/e2e` stay collectible.
    exclude: [...configDefaults.exclude, "tests/e2e/mock/**", "tests/e2e/real/**"],
  },
});
