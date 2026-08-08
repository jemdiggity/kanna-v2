export function isRealTestTarget(testTarget: string): boolean {
  return testTarget.includes("/real/");
}

export function shouldStartInitialInstances(firstTarget: string | undefined): boolean {
  return !firstTarget || !isRealTestTarget(firstTarget);
}

export function targetNeedsSecondaryInstance(testTarget: string): boolean {
  return /real\/local-transfer-.*\.test\.ts$/.test(testTarget) ||
    /real\/cloud-task-(?:sync|transfer)\.test\.ts$/.test(testTarget) ||
    /real\/remote-visual-companion\.test\.ts$/.test(testTarget);
}

export function targetNeedsEmulators(testTarget: string): boolean {
  return /real\/cloud-task-(?:sync|mobile-index|transfer)\.test\.ts$/.test(testTarget) ||
    /real\/mobile-relay-auth-recovery\.test\.ts$/.test(testTarget) ||
    /real\/mobile-pairing-ui\.test\.ts$/.test(testTarget) ||
    /real\/auth-indexeddb-fallback\.test\.ts$/.test(testTarget) ||
    /real\/remote-visual-companion\.test\.ts$/.test(testTarget);
}

export function targetNeedsRelay(testTarget: string): boolean {
  return /real\/cloud-task-(?:sync|mobile-index|transfer)\.test\.ts$/.test(testTarget) ||
    /real\/mobile-relay-auth-recovery\.test\.ts$/.test(testTarget) ||
    /real\/mobile-pairing-ui\.test\.ts$/.test(testTarget) ||
    /real\/remote-visual-companion\.test\.ts$/.test(testTarget);
}

export function targetNeedsRelayControl(testTarget: string): boolean {
  return /real\/remote-visual-companion\.test\.ts$/.test(testTarget);
}

export function targetNeedsIsolatedAgentProviders(testTarget: string): boolean {
  return /mock\/new-task-modal\.test\.ts$/.test(testTarget) ||
    /real\/remote-visual-companion\.test\.ts$/.test(testTarget);
}

export function targetNeedsPlaywrightChromium(testTarget: string): boolean {
  return /real\/remote-visual-companion\.test\.ts$/.test(testTarget);
}

export function relayStartupReportedListening(
  output: string,
  port: number,
): boolean {
  const expected = `[relay] Listening on port ${port}`;
  return output.split(/\r\n|\r|\n/u).some((line) => line.trim() === expected);
}

export function resolveRelayControlOperation(
  method: string | undefined,
  requestUrl: string | undefined,
  capability: string,
): "disconnect" | "reconnect" | null {
  if (method !== "POST" || capability.length < 32) return null;
  if (requestUrl === `/${capability}/disconnect`) return "disconnect";
  if (requestUrl === `/${capability}/reconnect`) return "reconnect";
  return null;
}
