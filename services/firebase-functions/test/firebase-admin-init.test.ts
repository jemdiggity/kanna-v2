import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const packageRoot = new URL("..", import.meta.url);

describe("compiled Firebase Admin initialization", () => {
  beforeAll(async () => {
    await execFileAsync("pnpm", ["build"], { cwd: packageRoot });
  });

  it("creates and reuses the default app when callable verification already created a named app", async () => {
    const script = String.raw`
      import { getApps, initializeApp } from "firebase-admin/app";
      import { getAuth } from "firebase-admin/auth";
      import { getFirestore } from "firebase-admin/firestore";

      initializeApp({ projectId: "named-only" }, "__FIREBASE_FUNCTIONS_SDK__");
      await import("./dist/src/index.js?first-load");
      initializeApp();

      const defaultApp = getApps().find((app) => app.name === "[DEFAULT]");
      if (!defaultApp) throw new Error("compiled entry point did not initialize [DEFAULT]");
      getFirestore(defaultApp);
      getAuth(defaultApp);
      process.stdout.write(JSON.stringify(getApps().map((app) => app.name).sort()));
    `;

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--input-type=module", "--eval", script],
      {
        cwd: packageRoot,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
        },
      },
    );

    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual(["[DEFAULT]", "__FIREBASE_FUNCTIONS_SDK__"]);
  });
});
