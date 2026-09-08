import { defineConfig } from "vitest/config";
import { sharedTestOptions } from "../../vitest.shared";

export default defineConfig({
  test: {
    ...sharedTestOptions,
    // The gate drives real processes, a real daemon and a real git repository
    // end to end. Nothing here is a unit test's kind of fast.
    testTimeout: 240_000,
    hookTimeout: 240_000,
  },
});
