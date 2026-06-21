#!/usr/bin/env node
/**
 * check-model-registry.js — Phase 4.4 stale-model probe.
 *
 * Hits each provider's `/models` endpoint (when one exists) and
 * diffs the live response against the hardcoded list in
 * `src/agent/providers-manager.ts` PROVIDER_REGISTRY. Prints a
 * "stale entries" report — model IDs that the registry advertises
 * but the provider no longer serves.
 *
 * Run manually, not in CI. The check requires the user to have a
 * key for each provider they want to validate (set via env vars
 * named `FIXO_CHECK_<PROVIDER>_KEY`, e.g. FIXO_CHECK_OPENAI_KEY).
 * Providers without a configured key are skipped with a note.
 *
 * Usage:
 *   node scripts/check-model-registry.js                  # all configured providers
 *   node scripts/check-model-registry.js openai groq      # subset
 *
 * Exit codes:
 *   0 — every model in every checked registry is still served
 *   1 — at least one stale model was found
 *   2 — script error (network down for ALL probes, etc.)
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// Parse PROVIDER_REGISTRY out of the source file directly to avoid
// adding a runtime dependency. The format is stable: an exported
// const array of object literals. We extract `name`, `baseUrl`, and
// `models` for each entry by matching a small block.
function loadRegistry() {
  const src = readFileSync(path.join(root, 'src/agent/providers-manager.ts'), 'utf-8');
  const out = [];
  // Crude block matcher — looks for `{ … name: '…' … models: [...] … }`
  // delimited by `},` between top-level object literals in the const
  // array. Sufficient for a manually-run script.
  const blockRe = /\{\s*name:\s*'([^']+)'[\s\S]*?baseUrl:\s*'([^']+)'[\s\S]*?models:\s*\[([\s\S]*?)\][\s\S]*?\}/g;
  let m;
  while ((m = blockRe.exec(src))) {
    const [, name, baseUrl, modelsLit] = m;
    const models = [...modelsLit.matchAll(/'([^']+)'/g)].map((mm) => mm[1]);
    if (name && baseUrl && models.length > 0) {
      out.push({ name, baseUrl, models });
    }
  }
  return out;
}

function envKeyFor(name) {
  return `FIXO_CHECK_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_KEY`;
}

async function fetchModelsOpenAICompat(baseUrl, key) {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const arr = body?.data ?? body?.models ?? [];
  return arr.map((m) => m?.id ?? m?.name).filter((s) => typeof s === 'string');
}

async function fetchModelsAnthropic(_baseUrl, key) {
  const res = await fetch('https://api.anthropic.com/v1/models', {
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return (body?.data ?? []).map((m) => m?.id).filter((s) => typeof s === 'string');
}

const PROVIDER_FETCH_OVERRIDES = {
  anthropic: fetchModelsAnthropic,
};

async function main() {
  const requested = process.argv.slice(2);
  const registry = loadRegistry();
  const targets = requested.length > 0
    ? registry.filter((p) => requested.includes(p.name))
    : registry;

  if (targets.length === 0) {
    console.error('No matching providers in registry.');
    process.exit(2);
  }

  let staleCount = 0;
  let checkedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const provider of targets) {
    const envName = envKeyFor(provider.name);
    const key = process.env[envName];
    if (!key) {
      console.log(`${provider.name}: skipped (no ${envName})`);
      skippedCount++;
      continue;
    }
    const fetcher = PROVIDER_FETCH_OVERRIDES[provider.name] ?? fetchModelsOpenAICompat;
    let live;
    try {
      live = await fetcher(provider.baseUrl, key);
    } catch (err) {
      console.log(`${provider.name}: error fetching /models — ${err.message ?? err}`);
      errorCount++;
      continue;
    }
    checkedCount++;
    const liveSet = new Set(live);
    const stale = provider.models.filter((m) => !liveSet.has(m));
    if (stale.length === 0) {
      console.log(`${provider.name}: ✓ all ${provider.models.length} registry entries served by /models`);
    } else {
      console.log(`${provider.name}: ✗ ${stale.length} stale — ${stale.join(', ')}`);
      staleCount += stale.length;
    }
  }

  console.log('');
  console.log(`Summary: checked=${checkedCount} skipped=${skippedCount} errors=${errorCount} stale=${staleCount}`);

  if (staleCount > 0) process.exit(1);
  if (checkedCount === 0) process.exit(2); // nothing was actually checked
  process.exit(0);
}

main().catch((err) => {
  console.error('check-model-registry: fatal —', err?.message ?? err);
  process.exit(2);
});
