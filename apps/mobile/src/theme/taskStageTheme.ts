/**
 * Stage colour for task rows, themed from the app icon.
 *
 * The icon (`assets/icon.png`) is a stack of rounded task pills running from a
 * hot orange/rose row at the top down through magenta, purple and indigo to a
 * cool blue/slate row, with one green dot. Those pills *are* task rows, so the
 * list borrows their colours directly: every hex in `KANNA_ICON_PALETTE` was
 * sampled out of that PNG rather than invented alongside it.
 *
 * Everything a row needs is derived from a single accent here, so iterating on
 * the look is a one-file change: move a stage to another palette entry, or
 * retune the blends, and every surface that renders a task follows.
 */

/** Colours sampled from `assets/icon.png` at 1024×1024. */
export const KANNA_ICON_PALETTE = {
  /** Right end of the top row's long pill. */
  orange: "#FF8C14",
  /** Left end of the top row's short pill. */
  rose: "#FB426E",
  /** Right end of the second row. */
  pink: "#F83087",
  /** Left end of the second row. */
  fuchsia: "#D921B3",
  /** The third row, flat — the icon's single most common saturated colour. */
  purple: "#A32ADB",
  /** Right end of the fourth row. */
  violet: "#4D35B4",
  /** Left end of the bottom row. */
  blue: "#144EB6",
  /** The lone dot at the top right. */
  green: "#14DE53",
  /** Right end of the bottom row, where the gradient runs out of colour. */
  slate: "#786E8F"
} as const;

export type KannaIconColorName = keyof typeof KANNA_ICON_PALETTE;

/** The unthemed card surface the stage tint is mixed into. */
const CARD_SURFACE = "#111B2C";
/** The unthemed card outline the stage border is mixed out of. */
const CARD_BORDER = "#20304C";
const WHITE = "#FFFFFF";

/** How far each derived colour travels from its base toward the accent. */
const SURFACE_TINT = 0.16;
const BORDER_TINT = 0.55;
const CHIP_TINT = 0.3;
/** Chip and stripe labels ride toward white until they clear 4.5:1 on the chip. */
const LABEL_LIFT = 0.62;

export interface TaskStageTheme {
  /** Which palette entry this stage resolved to. */
  colorName: KannaIconColorName;
  /** Full-strength icon colour: the row's left edge, and a pinned outline. */
  accent: string;
  /** Card background — the accent knocked back into the dark card surface. */
  surface: string;
  /** Card outline for an unpinned row. */
  border: string;
  /** Card outline for a pinned row: the same hue, unmuted. */
  pinnedBorder: string;
  /** Background of the stage pill. */
  chipBackground: string;
  /** Text inside the stage pill. */
  chipLabel: string;
}

function clampChannel(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

function parseHex(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16)
  ];
}

function toHex(channels: readonly [number, number, number]): string {
  return `#${channels
    .map((channel) => clampChannel(channel).toString(16).padStart(2, "0"))
    .join("")}`.toUpperCase();
}

/** Linear mix of two hex colours; `amount` is how much of `to` lands. */
export function mixHexColors(from: string, to: string, amount: number): string {
  const [fromRed, fromGreen, fromBlue] = parseHex(from);
  const [toRed, toGreen, toBlue] = parseHex(to);
  const ratio = Math.min(1, Math.max(0, amount));
  return toHex([
    fromRed + (toRed - fromRed) * ratio,
    fromGreen + (toGreen - fromGreen) * ratio,
    fromBlue + (toBlue - fromBlue) * ratio
  ]);
}

function channelLuminance(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance, for the contrast guard the tests assert. */
export function relativeLuminance(hex: string): number {
  const [red, green, blue] = parseHex(hex).map(channelLuminance);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function contrastRatio(left: string, right: string): number {
  const lighter = Math.max(relativeLuminance(left), relativeLuminance(right));
  const darker = Math.min(relativeLuminance(left), relativeLuminance(right));
  return (lighter + 0.05) / (darker + 0.05);
}

function stageThemeFor(colorName: KannaIconColorName): TaskStageTheme {
  const accent = KANNA_ICON_PALETTE[colorName];
  return {
    colorName,
    accent,
    surface: mixHexColors(CARD_SURFACE, accent, SURFACE_TINT),
    border: mixHexColors(CARD_BORDER, accent, BORDER_TINT),
    pinnedBorder: accent,
    chipBackground: mixHexColors(CARD_SURFACE, accent, CHIP_TINT),
    chipLabel: mixHexColors(accent, WHITE, LABEL_LIFT)
  };
}

/**
 * Stage → palette entry. The lifecycle runs warm to cool the way the icon
 * does: work in flight is the top row's orange, review is the icon's dominant
 * purple, and a task that reached its PR gets the green dot.
 */
const STAGE_COLOR_NAMES: Record<string, KannaIconColorName> = {
  "in progress": "orange",
  review: "purple",
  pr: "green",
  // The internal architect-consultation workflow's only stage.
  consultation: "blue"
};

/**
 * Stages a repo invented get a colour too, picked by name so the same custom
 * stage is always the same colour. Greying them out would read as "broken"
 * on exactly the workflows a repo cared enough to write.
 */
const CUSTOM_STAGE_COLOR_NAMES: readonly KannaIconColorName[] = [
  "pink",
  "fuchsia",
  "violet",
  "rose"
];

/** A row whose stage the desktop never reported falls back to the icon's grey. */
const UNKNOWN_STAGE_COLOR_NAME: KannaIconColorName = "slate";

/** Blocked is not a stage: it overlays whatever stage the task sits in. */
export const TASK_BLOCKED_THEME: TaskStageTheme = stageThemeFor("rose");

export function normalizeStageKey(stage: string | null | undefined): string {
  return (stage ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ");
}

function customStageColorName(stageKey: string): KannaIconColorName {
  let hash = 0;
  for (const character of stageKey) {
    hash = (hash * 31 + character.codePointAt(0)!) % 0xffffffff;
  }
  return CUSTOM_STAGE_COLOR_NAMES[hash % CUSTOM_STAGE_COLOR_NAMES.length];
}

/**
 * The one entry point every task surface calls. A missing stage is safe (the
 * neutral slate); an unrecognised one is still a real, stable palette entry.
 */
export function resolveTaskStageTheme(
  stage: string | null | undefined
): TaskStageTheme {
  const stageKey = normalizeStageKey(stage);
  if (!stageKey) return stageThemeFor(UNKNOWN_STAGE_COLOR_NAME);
  const known = STAGE_COLOR_NAMES[stageKey];
  return stageThemeFor(known ?? customStageColorName(stageKey));
}

/** Width of the saturated left edge that carries the stage colour. */
export const TASK_STAGE_STRIPE_WIDTH = 6;
