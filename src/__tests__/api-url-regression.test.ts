/**
 * api-url-regression.test.ts — Locks the deployed FreeLLMAPI endpoint
 * in place so a future merge can't silently revert it to the legacy
 * `api.freellmapi.com` host that broke Test 2 in the v1.0.x test log.
 *
 * The guards are deliberately string-level (regex on the source files
 * for setup-wizard / config) instead of runtime calls — we want the
 * test to fail at CI time the moment the symbol is replaced with a
 * literal or pointed at a stale host, not after a release.
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_API_URL } from "../config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, "..");

const LEGACY_HOSTS = [
  "api.freellmapi.com",
  "https://api.freellmapi.com",
  "freellm-liart.vercel.app",
  "https://freellm-liart.vercel.app",
];

test("DEFAULT_API_URL points at the production Vercel deployment over HTTPS", () => {
  assert.equal(DEFAULT_API_URL, "https://freellm-for-fixo.vercel.app/v1");
  assert.ok(DEFAULT_API_URL.startsWith("https://"), "must use HTTPS");
  assert.ok(DEFAULT_API_URL.endsWith("/v1"), "must end with /v1");
});

test("DEFAULT_API_URL does not regress to any known legacy host", () => {
  for (const host of LEGACY_HOSTS) {
    assert.ok(
      !DEFAULT_API_URL.includes(host),
      `DEFAULT_API_URL must not contain legacy host '${host}'`,
    );
  }
});

test("setup-wizard SaaS option binds to the DEFAULT_API_URL identifier (not a literal)", () => {
  const src = fs.readFileSync(path.join(srcRoot, "setup-wizard.ts"), "utf-8");
  // The SaaS option must reference the symbol, never inline a URL.
  // This catches the regression pattern: someone hardcodes a URL into
  // setup-wizard.ts that drifts from the canonical DEFAULT_API_URL.
  assert.match(
    src,
    /\{\s*value:\s*DEFAULT_API_URL\s*,\s*label:\s*'Cloud Hosted SaaS \(Default\)'/,
    "setup-wizard SaaS option must use the DEFAULT_API_URL identifier",
  );
});

test("no source file (other than config.ts) embeds the canonical SaaS URL literal", () => {
  // Every non-config source must reference DEFAULT_API_URL through
  // the imported symbol. If anyone hardcodes the production URL into
  // an unrelated module, the symbol becomes harder to change — exactly
  // the trap the v1.0.x publish fell into.
  const exemptions = new Set([
    "config.ts",
    "__tests__/sprint2-stability.test.ts",
    "__tests__/api-url-regression.test.ts",
    // Direct-mode tests deliberately assert that the proxy URL is
    // NOT contacted; they need to name the host in their assertions.
    "__tests__/direct-mode-bootstrap.test.ts",
    "__tests__/direct-mode-config.test.ts",
  ]);

  const offenders: string[] = [];
  walk(srcRoot, (rel, contents) => {
    if (!rel.endsWith(".ts")) return;
    if (exemptions.has(rel)) return;
    if (contents.includes("freellm-for-fixo.vercel.app")) {
      offenders.push(rel);
    }
  });
  assert.deepEqual(
    offenders,
    [],
    "these files embed the production URL literal — import DEFAULT_API_URL instead",
  );
});

test("no source file references the legacy api.freellmapi.com host", () => {
  const offenders: string[] = [];
  walk(srcRoot, (rel, contents) => {
    if (!rel.endsWith(".ts")) return;
    // Tests are allowed to mention the legacy host in assertion strings.
    if (rel.startsWith("__tests__/")) return;
    for (const host of LEGACY_HOSTS) {
      if (contents.includes(host)) {
        offenders.push(`${rel} mentions ${host}`);
        break;
      }
    }
  });
  assert.deepEqual(offenders, [], "legacy host still referenced in source");
});

function walk(root: string, cb: (rel: string, contents: string) => void): void {
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        stack.push(abs);
        continue;
      }
      const rel = path.relative(srcRoot, abs);
      try {
        const contents = fs.readFileSync(abs, "utf-8");
        cb(rel, contents);
      } catch {
        /* ignore unreadable */
      }
    }
  }
}
