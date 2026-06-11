#!/usr/bin/env node
/**
 * check-vendor-wasm.js — Fails the publish if a required vendored WASM
 * binary is missing or empty. Runs from `prepack`, so any local
 * `npm pack` / `npm publish` will abort before producing a broken
 * tarball. The previous 1.0.x publishes shipped without these blobs
 * and forced the CLI into the slow regex fallback at runtime.
 */
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const required = [
  'vendor/tree-sitter.wasm',
  'vendor/tree-sitter-bash.wasm',
];

let failed = false;
for (const rel of required) {
  const abs = path.join(root, rel);
  try {
    const s = statSync(abs);
    if (!s.isFile() || s.size === 0) {
      console.error(`✗ ${rel} is empty or not a regular file`);
      failed = true;
    } else {
      console.log(`✓ ${rel} (${s.size} bytes)`);
    }
  } catch {
    console.error(`✗ ${rel} is MISSING — refusing to pack/publish.`);
    failed = true;
  }
}

if (failed) {
  console.error(
    '\nThe vendor/ directory is required at runtime. Rebuild or restore\n' +
    'the WASM blobs before retrying. See parser-adapter.ts for usage.',
  );
  process.exit(1);
}
