/**
 * Child driver for the cross-process claim contention tests in
 * `runPorts.test.ts`.
 *
 * Port claims exist to hold a port across *processes*, and the collision they
 * guard against happens while one runner is still initializing its claim. Both
 * halves of that only exist between real processes, so the test drives this
 * script instead of calling `claimE2ePort` twice in one process, and the two
 * sides rendezvous through gate files rather than timing.
 *
 * Modes:
 * - `claim`        claim, report, release immediately.
 * - `hold`         claim, report, hold until the `release` gate appears.
 * - `hold-window`  block inside the claim's publication window until the
 *                  `resume` gate appears, then behave like `hold`.
 */
import { access, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import { claimE2ePort } from "./runPorts";

const MODES = ["claim", "hold", "hold-window"] as const;
type Mode = (typeof MODES)[number];

function parseMode(value: string | undefined): Mode {
  const mode = MODES.find((candidate) => candidate === value);
  if (!mode) throw new Error(`unknown mode ${value}; expected one of ${MODES.join(", ")}`);
  return mode;
}

async function waitForGate(gateDir: string, gate: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await access(join(gateDir, gate)).then(() => true, () => false)) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for gate ${gate}`);
}

async function main(): Promise<void> {
  const [portArg, modeArg, gateDir] = process.argv.slice(2);
  const port = Number.parseInt(portArg ?? "", 10);
  const mode = parseMode(modeArg);
  if (!Number.isInteger(port) || !gateDir) {
    throw new Error(`usage: runPortsClaimProcess.ts <port> <${MODES.join("|")}> <gateDir>`);
  }

  const release = await claimE2ePort(port, {
    onClaimPublished: mode === "hold-window"
      ? async () => {
        // Published, not yet resolved: exactly the window a competing runner
        // used to read as an ownerless claim.
        await writeFile(join(gateDir, "published"), `${process.pid}\n`);
        await waitForGate(gateDir, "resume");
      }
      : undefined,
  });

  process.stdout.write(`${JSON.stringify({ claimed: release !== null })}\n`);

  if (release && mode !== "claim") await waitForGate(gateDir, "release");
  await release?.();
}

await main();
