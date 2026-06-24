import type { ResolvedTheme } from "./types";

export interface ChartPalette {
  label: string;
  grid: string;
  tooltipBackground: string;
  tooltipBorder: string;
  tooltipText: string;
  createdLine: string;
  createdFill: string;
  closedLine: string;
  closedFill: string;
}

export interface AgentTerminalPalette {
  background: string;
  panel: string;
  panelRaised: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
}

interface ThemePalette {
  terminal: {
    background: string;
    foreground: string;
    cursor: string;
    selectionBackground: string;
    black: string;
    red: string;
    green: string;
    yellow: string;
    blue: string;
    magenta: string;
    cyan: string;
    white: string;
    brightBlack: string;
    brightRed: string;
    brightGreen: string;
    brightYellow: string;
    brightBlue: string;
    brightMagenta: string;
    brightCyan: string;
    brightWhite: string;
  };
  agentTerminal: AgentTerminalPalette;
  chart: ChartPalette;
}

export const themePalettes = {
  dark: {
    terminal: {
      background: "#20242d",
      foreground: "#d7deea",
      cursor: "#7db3ff",
      selectionBackground: "#1e5b93",
      black: "#0f1724",
      red: "#e06c75",
      green: "#6ea878",
      yellow: "#d7ba7d",
      blue: "#4f9fe6",
      magenta: "#c586c0",
      cyan: "#56b6c2",
      white: "#d7deea",
      brightBlack: "#6f7a8d",
      brightRed: "#ff7b86",
      brightGreen: "#86c98f",
      brightYellow: "#f0d98c",
      brightBlue: "#7db3ff",
      brightMagenta: "#d7a2d8",
      brightCyan: "#7fd3df",
      brightWhite: "#ffffff",
    },
    agentTerminal: {
      background: "#20242d",
      panel: "#252b36",
      panelRaised: "#2d3442",
      border: "#3d4657",
      text: "#d7deea",
      muted: "#8f9aac",
      accent: "#7db3ff",
    },
    chart: {
      label: "#888888",
      grid: "#333333",
      tooltipBackground: "#1e1e1e",
      tooltipBorder: "#444444",
      tooltipText: "#cccccc",
      createdLine: "#0066cc",
      createdFill: "rgba(0, 102, 204, 0.1)",
      closedLine: "#2ea043",
      closedFill: "rgba(46, 160, 67, 0.1)",
    },
  },
  light: {
    terminal: {
      background: "#f6f9ff",
      foreground: "#253044",
      cursor: "#0b66c3",
      selectionBackground: "#bfdbfe",
      black: "#1f2937",
      red: "#b42318",
      green: "#0b66c3",
      yellow: "#8a5a0a",
      blue: "#0b66c3",
      magenta: "#7c3f8c",
      cyan: "#087990",
      white: "#f6f9ff",
      brightBlack: "#687385",
      brightRed: "#d92d20",
      brightGreen: "#0a73dc",
      brightYellow: "#a66f1d",
      brightBlue: "#0a73dc",
      brightMagenta: "#9854b3",
      brightCyan: "#0891b2",
      brightWhite: "#ffffff",
    },
    agentTerminal: {
      background: "#f6f9ff",
      panel: "#eef4ff",
      panelRaised: "#e3efff",
      border: "#c2d3e8",
      text: "#253044",
      muted: "#687385",
      accent: "#0b66c3",
    },
    chart: {
      label: "#687385",
      grid: "#d9dee5",
      tooltipBackground: "#ffffff",
      tooltipBorder: "#c2cad4",
      tooltipText: "#1f2937",
      createdLine: "#0b66c3",
      createdFill: "rgba(11, 102, 195, 0.12)",
      closedLine: "#16803a",
      closedFill: "rgba(22, 128, 58, 0.12)",
    },
  },
} as const satisfies Record<ResolvedTheme, ThemePalette>;
