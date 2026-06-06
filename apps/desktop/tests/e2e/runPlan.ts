export function isRealTestTarget(testTarget: string): boolean {
  return testTarget.includes("/real/");
}

export function shouldStartInitialInstances(firstTarget: string | undefined): boolean {
  return !firstTarget || !isRealTestTarget(firstTarget);
}
