/**
 * Sci-fi futuristic design tokens. Single source of truth for the icarus
 * UI palette, typography, spacing, and motion. Components import from
 * here instead of hardcoding hex values.
 *
 * See plan.md → "UI design (sci-fi futuristic)" for the rationale.
 */

import { Platform } from "react-native";

export const palette = {
  // Backgrounds — deep navy → near-black ramp.
  bgDeep: "#05070d",
  bgBase: "#080b16",
  bgRaised: "#0d1322",
  bgPanel: "rgba(15, 22, 38, 0.72)",

  // Borders — translucent cyan hairlines.
  borderHair: "rgba(120, 220, 255, 0.18)",
  borderSoft: "rgba(120, 220, 255, 0.08)",
  borderStrong: "rgba(120, 220, 255, 0.32)",

  // Accents.
  cyan: "#5cf6ff",
  cyanDim: "rgba(92, 246, 255, 0.5)",
  cyanGlow: "rgba(92, 246, 255, 0.25)",
  violet: "#b78bff",
  violetDim: "rgba(183, 139, 255, 0.45)",
  amber: "#ffb454",
  green: "#76f5b0",
  rose: "#ff6b9b",

  // Text.
  textPrimary: "#dde6f5",
  textSecondary: "#7a89a8",
  textMuted: "#506074",
  textInverse: "#05070d",

  // States.
  danger: "#ff6b6b",
  dangerDim: "rgba(255, 107, 107, 0.18)",
} as const;

export const lensAccent = {
  product: palette.cyan,
  architect: palette.violet,
  engineer: palette.amber,
  ux: palette.rose,
  qa: palette.green,
} as const;

export const fonts = {
  body: Platform.select({
    web: "'Inter', system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
    default: "System",
  }) as string,
  mono: Platform.select({
    web: "'JetBrains Mono', 'Fira Code', 'Menlo', 'Consolas', monospace",
    default: "Menlo",
  }) as string,
} as const;

export const radii = {
  sm: 6,
  md: 10,
  lg: 14,
  pill: 999,
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

/** Soft outer glow used on focused / signal CTAs. Web-only — RN strips shadows. */
export function glow(color: string, blur = 16): Record<string, unknown> {
  if (Platform.OS !== "web") return {};
  return {
    // RN-Web maps boxShadow through to CSS.
    boxShadow: `0 0 ${blur}px ${color}`,
  };
}

/** Subtle 1px grid overlay, web-only. Layered as a pseudo via background. */
export const hudGrid = Platform.OS === "web"
  ? {
      backgroundImage:
        "linear-gradient(rgba(180,220,255,0.025) 1px, transparent 1px), linear-gradient(90deg, rgba(180,220,255,0.025) 1px, transparent 1px)",
      backgroundSize: "24px 24px, 24px 24px",
    }
  : {};

export const motion = {
  fast: 150,
  base: 220,
} as const;
