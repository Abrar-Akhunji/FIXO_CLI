/**
 * ui/index.ts — Barrel export for the FixO UI surface.
 *
 * Re-exports the brand palette (`C` + helpers), the logo, all
 * high-level render primitives, the session header, the plan
 * renderer, and the legacy `colors` object / `renderStatusLabel`
 * used by the rest of the codebase.
 *
 * Existing callers continue to import from the granular files
 * (e.g. `import { colors } from './colors.js'`); this barrel is
 * for the new code and the new tests.
 */

export * from './colors.js';
export * from './ascii.js';
export * from './render-primitives.js';
export * from './session-header.js';
export * from './plan-renderer.js';
