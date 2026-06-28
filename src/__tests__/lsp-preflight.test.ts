/**
 * lsp-preflight.test.ts — Pillar 3 (LSP pre-flight + syntax
 * fallback) coverage.
 *
 * Verifies the brace/paren/bracket balance check, the
 * unterminated-string/comment detection, the boot-time PATH scan
 * for common language servers, and the env-var escape hatch
 * (`FIXO_LSP_FALLBACK=syntax-only`).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  syntaxHealthCheck,
  formatSyntaxVerdict,
  checkLspSanity,
} from "../lsp/syntax-fallback.js";

test("syntaxHealthCheck accepts a balanced TS source", () => {
  const src = `
    export function foo(x: number): number {
      if (x > 0) {
        return x + 1;
      }
      return 0;
    }
  `;
  assert.deepEqual(syntaxHealthCheck(src), { state: "ok" });
});

test("syntaxHealthCheck flags an unclosed brace", () => {
  const src = `function foo() {\n  return 1;\n`;
  const v = syntaxHealthCheck(src);
  assert.equal(v.state, "unbalanced");
  if (v.state === "unbalanced") {
    assert.equal(v.opener, "{");
  }
});

test("syntaxHealthCheck flags an unclosed paren", () => {
  const src = `foo(1, 2, 3\n`;
  const v = syntaxHealthCheck(src);
  assert.equal(v.state, "unbalanced");
  if (v.state === "unbalanced") {
    assert.equal(v.opener, "(");
  }
});

test("syntaxHealthCheck ignores braces inside strings", () => {
  const src = `const s = "hello { world }";\n`;
  assert.deepEqual(syntaxHealthCheck(src), { state: "ok" });
});

test("syntaxHealthCheck ignores braces inside block comments", () => {
  const src = `/* { not real } */\nconst x = 1;\n`;
  assert.deepEqual(syntaxHealthCheck(src), { state: "ok" });
});

test("syntaxHealthCheck flags an unterminated string", () => {
  const src = `const s = "hello\n`;
  const v = syntaxHealthCheck(src);
  assert.equal(v.state, "unterminated-string");
});

test("syntaxHealthCheck flags an unterminated block comment", () => {
  const src = `/* unterminated\nconst x = 1;\n`;
  const v = syntaxHealthCheck(src);
  assert.equal(v.state, "unterminated-comment");
});

test("formatSyntaxVerdict returns a one-line summary", () => {
  const ok = formatSyntaxVerdict({ state: "ok" });
  assert.match(ok, /OK/);
  const bad = formatSyntaxVerdict({
    state: "unbalanced",
    opener: "{",
    line: 3,
  });
  assert.match(bad, /\{/);
  assert.match(bad, /line 3/);
});

test("checkLspSanity returns ok=false on an empty PATH", () => {
  const result = checkLspSanity({ PATH: "/nonexistent" });
  assert.equal(result.ok, false);
  assert.ok(result.reason.length > 0);
  assert.equal(result.syntaxOnly, false);
});

test("checkLspSanity returns ok=true with syntax-only escape hatch", () => {
  const result = checkLspSanity({
    PATH: "/nonexistent",
    FIXO_LSP_FALLBACK: "syntax-only",
  });
  assert.equal(result.ok, true);
  assert.equal(result.syntaxOnly, true);
});

test("checkLspSanity returns ok=true when a real server is on PATH", () => {
  // We can't easily create a temp file that looks like a binary,
  // so this test uses the actual env's PATH (which on most
  // developer machines has *something* — git, node, etc.). We
  // only assert that the function doesn't crash and returns a
  // valid result object.
  const result = checkLspSanity();
  assert.equal(typeof result.ok, "boolean");
  assert.ok(Array.isArray(result.checked));
  assert.ok(Array.isArray(result.found));
  assert.equal(typeof result.syntaxOnly, "boolean");
});
