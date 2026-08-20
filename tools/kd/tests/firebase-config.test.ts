import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface FirebaseHostingConfig {
  target?: string;
}

interface FirebaseConfig {
  hosting?: FirebaseHostingConfig | FirebaseHostingConfig[];
}

interface Firebaserc {
  projects?: Record<string, string>;
  targets?: Record<string, { hosting?: Record<string, string[]> }>;
}

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

describe("Firebase repository config", () => {
  it("maps every hosting target for the local, staging, and production projects", () => {
    const firebase = readJson<FirebaseConfig>(resolve(repoRoot, "firebase.json"));
    const firebaserc = readJson<Firebaserc>(resolve(repoRoot, ".firebaserc"));
    const hostingConfigs = Array.isArray(firebase.hosting)
      ? firebase.hosting
      : firebase.hosting
        ? [firebase.hosting]
        : [];
    const hostingTargets = hostingConfigs.flatMap(({ target }) => target ? [target] : []);

    expect(hostingTargets.length).toBeGreaterThan(0);
    for (const projectAlias of ["default", "staging", "production"]) {
      const projectId = firebaserc.projects?.[projectAlias];
      expect(projectId, `missing Firebase project alias ${projectAlias}`).toBeTruthy();
      for (const target of hostingTargets) {
        expect(
          firebaserc.targets?.[projectId ?? ""]?.hosting?.[target],
          `missing hosting target ${target} for ${projectAlias} project ${projectId ?? "<missing>"}`
        ).toEqual([expect.any(String)]);
      }
    }
  });
});
