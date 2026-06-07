/**
 * Re-export shim — `src/agent/web.ts` is the public surface for
 * fetch + search, but the implementations now live under
 * `src/agent/search/`. Existing imports keep working.
 */
export { webSearch } from './search/index.js';
export { webFetch } from './web-impl.js';
