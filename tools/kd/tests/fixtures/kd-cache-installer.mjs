import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  ensureKdInstallation,
  formatKdCacheEvent,
  writeKdManifest
} from "../../bin/kd-cache.mjs";

const [cacheRoot, identity, mode, buildLog, buildStartedMarker] =
  process.argv.slice(2);
const runtime = {
  nodeMajor: "24",
  platform: "darwin",
  arch: "arm64"
};

async function build({ outputDir }) {
  appendFileSync(buildLog, `${process.pid}\n`);
  mkdirSync(join(outputDir, "bin"), { recursive: true });
  writeFileSync(join(outputDir, "bin/kd.js"), "partial\n");
  if (mode === "hang") {
    writeFileSync(buildStartedMarker, `${process.pid}\n`);
    await delay(60_000);
  } else {
    await delay(75);
  }
  writeFileSync(join(outputDir, "bin/kd-mcp.js"), "#!/usr/bin/env node\n");
  writeKdManifest(outputDir, identity, runtime);
}

try {
  const entrypoint = await ensureKdInstallation({
    cacheRoot,
    identity,
    entrypoint: "kd",
    runtime,
    build,
    pollIntervalMs: 10,
    waitTimeoutMs: 5_000,
    onCacheEvent: (event) => {
      process.stderr.write(`${formatKdCacheEvent(event)}\n`);
    }
  });
  process.stdout.write(`${entrypoint}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
