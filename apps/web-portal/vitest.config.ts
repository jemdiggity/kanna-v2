import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";
import { sharedTestOptions } from "../../vitest.shared";

const authEmulatorPort = process.env.KANNA_FIREBASE_AUTH_PORT || process.env.VITE_FIREBASE_AUTH_EMULATOR_PORT || "9099";
const firestoreEmulatorPort = process.env.KANNA_FIREBASE_FIRESTORE_PORT || process.env.VITE_FIREBASE_FIRESTORE_EMULATOR_PORT || "8080";
const functionsEmulatorPort = process.env.KANNA_FIREBASE_FUNCTIONS_PORT || process.env.VITE_FIREBASE_FUNCTIONS_EMULATOR_PORT || "5001";

export default defineConfig({
  plugins: [vue()],
  define: {
    "import.meta.env.VITE_FIREBASE_AUTH_EMULATOR_PORT": JSON.stringify(authEmulatorPort),
    "import.meta.env.VITE_FIREBASE_FIRESTORE_EMULATOR_PORT": JSON.stringify(firestoreEmulatorPort),
    "import.meta.env.VITE_FIREBASE_FUNCTIONS_EMULATOR_PORT": JSON.stringify(functionsEmulatorPort)
  },
  test: {
    ...sharedTestOptions,
    environment: "happy-dom"
  }
});
