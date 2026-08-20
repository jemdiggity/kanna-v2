import { defineConfig } from "vitest/config";
import { sharedTestOptions } from "../../vitest.shared";

export default defineConfig({
  test: {
    ...sharedTestOptions,
    include: ["tests/offline/**/*.test.ts"],
    // Offline CLI-contract cases shell out to real agent binaries, so they need
    // more than the shared ceiling rather than less.
    testTimeout: 120_000,
  },
});
