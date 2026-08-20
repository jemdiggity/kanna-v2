import { defineConfig } from "vitest/config";
import { sharedTestOptions } from "../../vitest.shared";

export default defineConfig({
  test: {
    ...sharedTestOptions,
    // Several files in this package drive the one shared Firestore emulator and
    // wipe it between tests, so they must not run at the same time as each
    // other. Tests within a file already run sequentially.
    fileParallelism: false,
  },
});
