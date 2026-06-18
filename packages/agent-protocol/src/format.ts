const COMPACT_COUNT_SUFFIXES = ["", "k", "M", "B", "T"] as const;

export function formatCompactCount(value: number): string {
  if (!Number.isFinite(value)) return "0";

  const sign = value < 0 ? "-" : "";
  let scaled = Math.abs(value);
  let suffixIndex = 0;

  while (scaled >= 1000 && suffixIndex < COMPACT_COUNT_SUFFIXES.length - 1) {
    scaled /= 1000;
    suffixIndex += 1;
  }

  if (suffixIndex === 0) return `${sign}${Math.round(scaled)}`;

  let rounded = Math.round(scaled * 10) / 10;
  if (rounded >= 1000 && suffixIndex < COMPACT_COUNT_SUFFIXES.length - 1) {
    rounded /= 1000;
    suffixIndex += 1;
  }

  return `${sign}${rounded.toFixed(1).replace(/\.0$/, "")}${COMPACT_COUNT_SUFFIXES[suffixIndex]}`;
}
