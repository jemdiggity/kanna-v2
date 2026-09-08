export type DesktopRealE2eTier = "unattended" | "operator";

export function buildDesktopRealE2eCommand(
  tier: DesktopRealE2eTier,
): [string, string[]] {
  return [
    "pnpm",
    ["--dir", "apps/desktop", "test:e2e", `real-${tier}`],
  ];
}

/**
 * The desktop mock E2E lane. It drives the real app through WebDriver, so it
 * cannot be collected by a bare `vitest run` (see `apps/desktop/vitest.config.ts`,
 * which excludes `tests/e2e/mock/**`) and therefore never ran inside `pnpm test`.
 */
export function buildDesktopMockE2eCommand(): [string, string[]] {
  return ["pnpm", ["--dir", "apps/desktop", "test:e2e", "mock/"]];
}
