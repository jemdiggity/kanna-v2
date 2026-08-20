import { describe, expect, it } from "vitest";
import {
  KANNA_ICON_PALETTE,
  TASK_BLOCKED_THEME,
  contrastRatio,
  mixHexColors,
  normalizeStageKey,
  relativeLuminance,
  resolveTaskStageTheme,
  taskStageThemeForColor,
  type KannaIconColorName
} from "./taskStageTheme";

/** The card title colour every stage surface has to stay readable under. */
const TITLE_COLOR = "#F3F7FF";
const PALETTE_HEXES = Object.values(KANNA_ICON_PALETTE);

describe("KANNA_ICON_PALETTE", () => {
  it("holds only colours sampled from the icon, as full hex triplets", () => {
    for (const hex of PALETTE_HEXES) {
      expect(hex).toMatch(/^#[0-9A-F]{6}$/);
    }
    // Sampled from assets/icon.png — the three colours the icon uses most.
    expect(KANNA_ICON_PALETTE.purple).toBe("#A32ADB");
    expect(KANNA_ICON_PALETTE.blue).toBe("#144EB6");
    expect(KANNA_ICON_PALETTE.green).toBe("#14DE53");
  });
});

describe("resolveTaskStageTheme", () => {
  it.each<[string, KannaIconColorName]>([
    ["in progress", "orange"],
    ["review", "purple"],
    ["pr", "green"],
    ["consultation", "blue"]
  ])("maps the %s stage to the icon's %s", (stage, colorName) => {
    const theme = resolveTaskStageTheme(stage);
    expect(theme.colorName).toBe(colorName);
    expect(theme.accent).toBe(KANNA_ICON_PALETTE[colorName]);
  });

  it.each(["In Progress", "IN PROGRESS", "in-progress", "in_progress", "  in   progress  "])(
    "resolves %j to the same stage colour as its canonical spelling",
    (stage) => {
      expect(resolveTaskStageTheme(stage)).toEqual(
        resolveTaskStageTheme("in progress")
      );
    }
  );

  it.each([null, undefined, "", "   "])(
    "falls back to the neutral slate when the stage is %j",
    (stage) => {
      const theme = resolveTaskStageTheme(stage);
      expect(theme.colorName).toBe("slate");
      expect(theme.accent).toBe(KANNA_ICON_PALETTE.slate);
    }
  );

  it("gives an unrecognised stage a real palette colour, stably", () => {
    const first = resolveTaskStageTheme("qa sweep");
    const second = resolveTaskStageTheme("QA Sweep");
    expect(first).toEqual(second);
    expect(PALETTE_HEXES).toContain(first.accent);
    // Never the neutral: that reading is reserved for "no stage reported".
    expect(first.colorName).not.toBe("slate");
  });

  it("keeps a distinct colour for at least a few different custom stages", () => {
    const customStages = ["qa", "design", "merge", "soak", "triage", "docs"];
    const colors = new Set(
      customStages.map((stage) => resolveTaskStageTheme(stage).colorName)
    );
    expect(colors.size).toBeGreaterThan(1);
  });

  it.each([
    "in progress",
    "review",
    "pr",
    "consultation",
    "qa",
    null
  ])("keeps text readable on the %j stage surface", (stage) => {
    const theme = resolveTaskStageTheme(stage);
    // WCAG AA for body text, on the card and its stage pill alike.
    expect(contrastRatio(TITLE_COLOR, theme.surface)).toBeGreaterThanOrEqual(7);
    expect(
      contrastRatio(theme.chipLabel, theme.chipBackground)
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(theme.secondaryLabel, theme.surface)
    ).toBeGreaterThanOrEqual(4.5);
  });

  // Every palette entry, not only the ones the named stages happen to use: a
  // custom stage hashes onto any of them, and the secondary label is the
  // colour with the least headroom over the tint, so this is where a future
  // palette edit would quietly drop the repo label back under AA.
  it.each(Object.keys(KANNA_ICON_PALETTE) as KannaIconColorName[])(
    "keeps the secondary label readable on the %s surface",
    (colorName) => {
      const theme = taskStageThemeForColor(colorName);
      expect(theme.colorName).toBe(colorName);
      expect(
        contrastRatio(theme.secondaryLabel, theme.surface)
      ).toBeGreaterThanOrEqual(4.5);
    }
  );

  it("separates the pinned outline from the unpinned one without changing hue", () => {
    for (const stage of ["in progress", "review", "pr", null]) {
      const theme = resolveTaskStageTheme(stage);
      // Pin brightens the same stage colour; it never recolours the row, so
      // the pinned outline and the stage stripe stay one signal.
      expect(theme.pinnedBorder).toBe(theme.accent);
      expect(theme.pinnedBorder).not.toBe(theme.border);
      expect(relativeLuminance(theme.pinnedBorder)).toBeGreaterThan(
        relativeLuminance(theme.border)
      );
    }
  });

  it("tints the card without flattening it into the accent", () => {
    const theme = resolveTaskStageTheme("review");
    expect(theme.surface).not.toBe(theme.accent);
    // The surface stays dark enough to read as a card, not as a colour swatch.
    expect(relativeLuminance(theme.surface)).toBeLessThan(0.12);
  });
});

describe("TASK_BLOCKED_THEME", () => {
  it("uses its own icon colour so it reads over any stage", () => {
    expect(TASK_BLOCKED_THEME.accent).toBe(KANNA_ICON_PALETTE.rose);
    expect(
      contrastRatio(
        TASK_BLOCKED_THEME.chipLabel,
        TASK_BLOCKED_THEME.chipBackground
      )
    ).toBeGreaterThanOrEqual(4.5);
  });
});

describe("colour helpers", () => {
  it("mixes hex colours end to end", () => {
    expect(mixHexColors("#000000", "#FFFFFF", 0)).toBe("#000000");
    expect(mixHexColors("#000000", "#FFFFFF", 1)).toBe("#FFFFFF");
    expect(mixHexColors("#000000", "#FFFFFF", 0.5)).toBe("#808080");
  });

  it("clamps a mix amount outside the unit range", () => {
    expect(mixHexColors("#000000", "#FFFFFF", -1)).toBe("#000000");
    expect(mixHexColors("#000000", "#FFFFFF", 4)).toBe("#FFFFFF");
  });

  it("computes the WCAG contrast of black on white symmetrically", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 5);
  });

  it("normalizes stage spellings to one key", () => {
    expect(normalizeStageKey(" In-Progress ")).toBe("in progress");
    expect(normalizeStageKey(null)).toBe("");
  });
});
