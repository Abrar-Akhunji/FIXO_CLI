/**
 * 24-bit TrueColor ANSI escape sequences for the FixO Theme.
 * Supports dynamic toggling between Dark Mode ('dark') and High-Contrast Inverted Mode ('inverted').
 */

export let themeMode: 'dark' | 'inverted' = 'dark';

export function setThemeMode(mode: 'dark' | 'inverted') {
  themeMode = mode;
}

export const colors = {
  get reset() { return '\x1b[0m'; },
  get bold() { return '\x1b[1m'; },
  get dim() { return '\x1b[2m'; },
  get underline() { return '\x1b[4m'; },

  // Snow (#FBFBFB)
  get snow() {
    return themeMode === 'dark' ? '\x1b[38;2;251;251;251m' : '\x1b[38;2;21;20;25m';
  },
  get bgSnow() {
    return themeMode === 'dark' ? '\x1b[48;2;251;251;251m' : '\x1b[48;2;21;20;25m';
  },

  // Dark Void (#151419)
  get darkVoid() {
    return themeMode === 'dark' ? '\x1b[38;2;21;20;25m' : '\x1b[38;2;251;251;251m';
  },
  get bgDarkVoid() {
    return themeMode === 'dark' ? '\x1b[48;2;21;20;25m' : '\x1b[48;2;251;251;251m';
  },

  // Liquid Lava (#F56E0F)
  get liquidLava() {
    return '\x1b[38;2;245;110;15m';
  },
  get bgLiquidLava() {
    return '\x1b[48;2;245;110;15m';
  },

  // Compatibility Mappings mapped to our Theme Palette
  get cyan() { return '\x1b[38;2;56;189;248m'; },
  get blue() { return '\x1b[38;2;96;165;250m'; },
  get magenta() { return '\x1b[38;2;236;72;153m'; },
  get white() { return this.snow; },
  get green() { return '\x1b[38;2;76;175;80m'; },
  get yellow() { return '\x1b[38;2;245;180;64m'; },
  get red() { return '\x1b[38;2;244;67;54m'; },
  get gray() { return '\x1b[38;2;145;145;155m'; },
  get bgCyan() { return '\x1b[48;2;56;189;248m'; },
};

/** Helper to render a high-contrast label with Snow background and Dark Void text */
export function renderStatusLabel(text: string): string {
  return `${colors.bgSnow}${colors.darkVoid} ${text} ${colors.reset}`;
}
