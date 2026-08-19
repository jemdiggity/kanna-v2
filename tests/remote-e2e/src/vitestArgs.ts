export function remoteHarnessSpecFiles(staging: boolean): string[] {
  return staging
    ? ["src/staging-smoke.e2e.test.ts"]
    : [
        "src/remote-harness.smoke.test.ts",
        "src/cloud-pairing-auth-discovery.e2e.test.ts",
        "src/terminal-flow.e2e.test.ts",
        "src/task-listing-actions.e2e.test.ts",
        "src/lan-layer.e2e.test.ts",
        "src/task-image-attachment.e2e.test.ts"
      ];
}

export function remoteHarnessVitestArgs(specFile: string): string[] {
  return [
    "exec",
    "vitest",
    "run",
    "--no-file-parallelism",
    "--maxWorkers=1",
    "--maxConcurrency=1",
    "--hookTimeout=240000",
    "--testTimeout=120000",
    specFile
  ];
}
