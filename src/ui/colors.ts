/**
 * 24-bit TrueColor ANSI escape sequences for the FixO Theme.
 * Supports dynamic toggling between Dark Mode ('dark') and High-Contrast Inverted Mode ('inverted').
 *
 * The legacy `colors` object is preserved for backward compatibility
 * with the 305+ tests that import it. The new `C` palette is the
 * canonical brand identity — the "Liquid Lava" / "Dark Void" / "Snow"
 * triad that's used across the new UI primitives in
 * `src/ui/render.ts` and friends.
 */

export let themeMode: "dark" | "inverted" = "dark";

export function setThemeMode(mode: "dark" | "inverted") {
  themeMode = mode;
}

/* ──────────────────────── Legacy palette (preserved) ──────────────────────── */

export const colors = {
  get reset() {
    return "\x1b[0m";
  },
  get bold() {
    return "\x1b[1m";
  },
  get dim() {
    return "\x1b[2m";
  },
  get underline() {
    return "\x1b[4m";
  },

  // Snow (#FBFBFB)
  get snow() {
    return themeMode === "dark"
      ? "\x1b[38;2;251;251;251m"
      : "\x1b[38;2;21;20;25m";
  },
  get bgSnow() {
    return themeMode === "dark"
      ? "\x1b[48;2;251;251;251m"
      : "\x1b[48;2;21;20;25m";
  },

  // Dark Void (#151419)
  get darkVoid() {
    return themeMode === "dark"
      ? "\x1b[38;2;21;20;25m"
      : "\x1b[38;2;251;251;251m";
  },
  get bgDarkVoid() {
    return themeMode === "dark"
      ? "\x1b[48;2;21;20;25m"
      : "\x1b[48;2;251;251;251m";
  },

  // Liquid Lava (#F56E0F)
  get liquidLava() {
    return "\x1b[38;2;245;110;15m";
  },
  get bgLiquidLava() {
    return "\x1b[48;2;245;110;15m";
  },

  // Compatibility Mappings mapped to our Theme Palette
  get cyan() {
    return "\x1b[38;2;56;189;248m";
  },
  get blue() {
    return "\x1b[38;2;96;165;250m";
  },
  get magenta() {
    return "\x1b[38;2;236;72;153m";
  },
  get white() {
    return this.snow;
  },
  get green() {
    return "\x1b[38;2;76;175;80m";
  },
  get yellow() {
    return "\x1b[38;2;245;180;64m";
  },
  get red() {
    return "\x1b[38;2;244;67;54m";
  },
  get gray() {
    return "\x1b[38;2;145;145;155m";
  },
  get bgCyan() {
    return "\x1b[48;2;56;189;248m";
  },
};

/** Helper to render a high-contrast label with Snow background and Dark Void text */
export function renderStatusLabel(text: string): string {
  return `${colors.bgSnow}${colors.darkVoid} ${text} ${colors.reset}`;
}

/* ──────────────────────── C palette (brand identity) ──────────────────────── */

/**
 * Canonical FixO brand palette. The first class — `LAVA` —
 * is the primary accent used on EVERY key highlight, the
 * ASCII logo, the prompt glyph, the status-bar pills, and the
 * top border of the AI response frame.
 *
 * The hex values are duplicated as comment annotations so the
 * palette can be audited without an external reference.
 */
export const C = {
  // Brand
  LAVA: "\x1b[38;2;245;110;15m", // #F56E0F — primary accent
  LAVA_BG: "\x1b[48;2;42;26;10m", // dark orange surface
  LAVA_DIM: "\x1b[38;2;122;54;8m", // muted lava for secondary accents

  // Backgrounds (used as surface layers)
  VOID: "\x1b[48;2;21;20;25m", // #151419 — deepest bg
  VOID2: "\x1b[48;2;28;27;33m", // slightly lifted surface
  VOID3: "\x1b[48;2;35;34;40m", // hover / selected row bg
  VOID4_FG: "\x1b[38;2;46;45;53m", // border color as foreground

  // Text
  SNOW: "\x1b[38;2;251;251;251m", // #FBFBFB — primary text
  SNOW2: "\x1b[38;2;200;200;200m", // secondary text
  SNOW3: "\x1b[38;2;136;136;136m", // muted / hints
  SNOW4: "\x1b[38;2;68;68;68m", // very dim / decorative

  // Semantic (tool call types)
  BLUE: "\x1b[38;2;96;165;250m", // ReadFile, info
  GREEN: "\x1b[38;2;74;222;128m", // success
  YELLOW: "\x1b[38;2;250;204;21m", // Bash, warnings
  PURPLE: "\x1b[38;2;192;132;252m", // WriteFile, AI highlights
  RED: "\x1b[38;2;248;113;113m", // errors

  // Provider colors
  P_ANTHROPIC: "\x1b[38;2;245;110;15m",
  P_GOOGLE: "\x1b[38;2;74;222;128m",
  P_GROQ: "\x1b[38;2;250;204;21m",
  P_OPENAI: "\x1b[38;2;96;165;250m",
  P_ZEN: "\x1b[38;2;192;132;252m",
  P_MISTRAL: "\x1b[38;2;251;191;36m",
  P_NVIDIA: "\x1b[38;2;134;239;172m",

  // Formatting
  BOLD: "\x1b[1m",
  DIM: "\x1b[2m",
  RESET: "\x1b[0m",
  NL: "\n",
} as const;

/* ──────────────────────── Helper wrappers ──────────────────────── */

/**
 * Helper wrappers that wrap a string in a colour + RESET.
 * Pure, allocation-light, safe to use in any hot path.
 */
export function lava(text: string): string {
  return `${C.LAVA}${text}${C.RESET}`;
}
export function snow(text: string): string {
  return `${C.SNOW}${text}${C.RESET}`;
}
export function dim(text: string): string {
  return `${C.SNOW4}${text}${C.RESET}`;
}
export function green(text: string): string {
  return `${C.GREEN}${text}${C.RESET}`;
}
export function blue(text: string): string {
  return `${C.BLUE}${text}${C.RESET}`;
}
export function yellow(text: string): string {
  return `${C.YELLOW}${text}${C.RESET}`;
}
export function purple(text: string): string {
  return `${C.PURPLE}${text}${C.RESET}`;
}
export function red(text: string): string {
  return `${C.RED}${text}${C.RESET}`;
}
export function bold(text: string): string {
  return `${C.BOLD}${text}${C.RESET}`;
}

/**
 * Visible-character length of a string with ANSI escapes removed.
 * Use this whenever you need to pad an ANSI-coloured string to a
 * target column width — `.length` over-counts because it includes
 * the escape bytes.
 */
export function visLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/**
 * Pad a string (which may contain ANSI escapes) to a target
 * visual width. If the string is already at or beyond the target,
 * it is returned unchanged. Negative widths are treated as zero.
 */
export function padToVisual(s: string, width: number, char = " "): string {
  const v = visLen(s);
  if (v >= width) return s;
  return s + char.repeat(width - v);
}

/**
 * Pick the brand colour for a provider by its display name.
 * Returns the colour code; callers add the text and RESET.
 */
export function providerColor(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("anthropic") || lower.includes("claude"))
    return C.P_ANTHROPIC;
  if (lower.includes("google") || lower.includes("gemini")) return C.P_GOOGLE;
  if (lower.includes("groq")) return C.P_GROQ;
  if (lower.includes("openai")) return C.P_OPENAI;
  if (lower.includes("zen") || lower.includes("opencode")) return C.P_ZEN;
  if (lower.includes("mistral")) return C.P_MISTRAL;
  if (lower.includes("nvidia") || lower.includes("nim")) return C.P_NVIDIA;
  return C.SNOW2;
}

/**
 * Render a single pill: `${bg}${fg} ${text} ${RESET}`.
 * Used by the status bar and any other place a labelled chip
 * needs a coloured background.
 */
export function pill(text: string, fg: string, bg: string): string {
  return `${bg}${fg} ${text} ${C.RESET}`;
}
