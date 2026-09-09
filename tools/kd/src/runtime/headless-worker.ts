/**
 * `./kd test headless-worker` — Linux Phase 1's exit gate.
 *
 * The lane drives a real `kanna-worker`, which supervises a real daemon and a
 * real server, so it needs those binaries built first. Building them here
 * rather than expecting the caller to is what makes the lane runnable from a
 * clean checkout on either platform.
 */

export function buildHeadlessWorkerBinariesCommand(): [string, string[]] {
  return [
    "cargo",
    [
      "build",
      "-p",
      "kanna-worker",
      "-p",
      "kanna-daemon",
      "-p",
      "kanna-server",
      "-p",
      "kanna-cli",
    ],
  ];
}

export function buildHeadlessWorkerGateCommand(): [string, string[]] {
  return ["pnpm", ["--dir", "tests/headless-worker", "run", "test:gate"]];
}
