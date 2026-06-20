import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
export const PACKAGE_ROOT = path.join(REPO_ROOT, "tests/tui-fidelity");
export const FIXTURE_DIR = path.join(PACKAGE_ROOT, "fixtures");
export const GOLDEN_DIR = path.join(PACKAGE_ROOT, "goldens");
export const ARTIFACT_DIR = path.join(REPO_ROOT, ".build/tui-fidelity");
