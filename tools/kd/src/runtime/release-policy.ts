import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The release lifecycle's tunable safety policy. Deliberately a file rather
 * than a constant in code: the soak window is a release-process decision the
 * repo owns, and an operator reading `kd release status` must be able to see
 * where the number came from.
 */
export interface ReleasePolicy {
  /**
   * Hours a staging release candidate must have been published before it may be
   * promoted to production. `0` disables the gate; there is no upper bound.
   */
  productionSoakHours: number;
}

export const RELEASE_POLICY_FILE = "release-policy.json";

export const DEFAULT_RELEASE_POLICY: ReleasePolicy = {
  productionSoakHours: 24
};

const KNOWN_KEYS = new Set(["$schema", "productionSoakHours"]);

export function parseReleasePolicy(raw: unknown, sourceLabel: string): ReleasePolicy {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${sourceLabel} must contain a JSON object.`);
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!KNOWN_KEYS.has(key)) {
      throw new Error(
        `${sourceLabel} has unknown key ${JSON.stringify(key)}. Supported keys: productionSoakHours.`
      );
    }
  }
  const policy = { ...DEFAULT_RELEASE_POLICY };
  if ("productionSoakHours" in record) {
    const value = record.productionSoakHours;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`${sourceLabel} productionSoakHours must be a non-negative number of hours.`);
    }
    policy.productionSoakHours = value;
  }
  return policy;
}

export function releasePolicyPath(repoRoot: string): string {
  return join(repoRoot, RELEASE_POLICY_FILE);
}

/**
 * Reads the repo's release policy. A missing file is the documented default —
 * a repo that never opts in still gets the standard soak gate — but a present
 * file that does not parse is an error, never a silent fallback.
 */
export function readReleasePolicy(repoRoot: string): ReleasePolicy {
  const path = releasePolicyPath(repoRoot);
  if (!existsSync(path)) return { ...DEFAULT_RELEASE_POLICY };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseReleasePolicy(parsed, path);
}
