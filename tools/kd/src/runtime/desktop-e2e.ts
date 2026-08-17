export type DesktopRealE2eTier = "unattended" | "operator";

export function buildDesktopRealE2eCommand(
  tier: DesktopRealE2eTier,
): [string, string[]] {
  return [
    "pnpm",
    ["--dir", "apps/desktop", "test:e2e", `real-${tier}`],
  ];
}
