/**
 * ascii.ts — The FixO ASCII logo + `renderLogo()` entry point.
 *
 * The logo is six rows of block-letter `█` characters, rendered
 * entirely in `C.LAVA` so it pops against the dark void
 * background. Below it sits a single tagline line in `C.SNOW4`
 * (very dim) with the version + three brand keywords.
 *
 * The block characters are intentional — they render the same
 * width in every monospace font and don't trigger the
 * "double-wide emoji" behaviour that some terminals apply to
 * glyphs in the supplementary plane.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { C } from "./colors.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkgPath = join(__dirname, "..", "..", "package.json");
let cliVersion = "2.0.0";
try {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  if (pkg.version) cliVersion = pkg.version;
} catch {
  // fallback if package.json is missing or malformed
}

const LOGO_LINES: ReadonlyArray<string> = [
  " ███████╗██╗██╗  ██╗ ██████╗      ██████╗██╗     ██╗",
  " ██╔════╝██║╚██╗██╔╝██╔═══██╗    ██╔════╝██║     ██║",
  " █████╗  ██║ ╚███╔╝ ██║   ██║    ██║     ██║     ██║",
  " ██╔══╝  ██║ ██╔██╗ ██║   ██║    ██║     ██║     ██║",
  " ██║     ██║██╔╝ ██╗╚██████╔╝    ╚██████╗███████╗██║",
  " ╚═╝     ╚═╝╚═╝  ╚═╝ ╚═════╝      ╚═════╝╚══════╝╚═╝",
];

/** Returns the logo lines, each pre-coloured in LAVA. */
export function getLavaLogo(): string {
  return LOGO_LINES.map((line) => `${C.LAVA}${line}${C.RESET}`).join("\n");
}

/** Returns just the tagline (used by tests and by `renderLogo`). */
export function getTagline(): string {
  const TAGLINE = ` v${cliVersion}  ·  autonomous  ·  free  ·  multi-provider  ·  freellmapi`;
  return `${C.SNOW4}${TAGLINE}${C.RESET}`;
}

/**
 * Print the logo + tagline + one blank line to stdout.
 * Never throws. Safe to call on non-TTY (no-op fallback).
 */
export function renderLogo(): void {
  try {
    process.stdout.write(getLavaLogo() + "\n");
    process.stdout.write(getTagline() + "\n\n");
  } catch {
    // stdout may be closed during teardown — never let that crash the agent.
  }
}
