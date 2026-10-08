/** Compact FIXO identity for terminals that do not use the full-screen UI. */

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

// A nine-cell, dotted F monogram: compact enough for every terminal width.
const LOGO_LINES: ReadonlyArray<string> = [
  "  ● ● ●",
  "  ● ● ·  FIXO",
  "  ● · ·  CLI",
];

/** Returns the logo lines, each pre-coloured in LAVA. */
export function getLavaLogo(): string {
  return LOGO_LINES.map((line) => `${C.LAVA}${line}${C.RESET}`).join("\n");
}

/** Returns just the tagline (used by tests and by `renderLogo`). */
export function getTagline(): string {
  const TAGLINE = `  v${cliVersion}  ·  your coding workspace`;
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
