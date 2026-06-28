/**
 * fixo-md-watcher.test.ts — Phase 4 tests.
 *
 * Locks in the six cases:
 *   (a) no FIXO.md → always `unchanged`, no directive;
 *   (b) FIXO.md present at start → first `check()` returns
 *       `unchanged` (already baked into the system prompt);
 *   (c) FIXO.md updated mid-run → returns `updated` with the
 *       refreshed content in the directive;
 *   (d) FIXO.md deleted mid-run → returns `deleted` with a
 *       directive that names the previous path;
 *   (e) FIXO.md created mid-run → returns `created`;
 *   (f) updated → unchanged dedup on the second consecutive check.
 *
 * Each test uses a fresh temp dir for `cwd` so the lookup chain
 * resolves deterministically without touching the user's home
 * directory.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { FixoMdWatcher } from "../context/fixo-md-watcher.js";

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fixo-md-watcher-"));
}

function writeFixoMd(cwd: string, content: string): string {
  const p = path.join(cwd, "FIXO.md");
  fs.writeFileSync(p, content, "utf-8");
  return p;
}

/**
 * `mtimeMs` resolution on macOS HFS+ is one second; a quick
 * write→write within the same millisecond can produce identical
 * mtimes and trip the fingerprint check. Bump the mtime manually
 * so the watcher sees a real delta.
 */
function bumpMtime(p: string): void {
  const now = new Date();
  const future = new Date(now.getTime() + 2000);
  fs.utimesSync(p, future, future);
}

/* ──────────────────── (a) no file ──────────────────── */

test("no FIXO.md present → always unchanged, no directive", () => {
  const cwd = mkTmp();
  try {
    const watcher = new FixoMdWatcher(cwd);
    const r1 = watcher.check();
    assert.equal(r1.kind, "unchanged");
    assert.equal(watcher.formatDirective(r1), null);

    // Re-check immediately. Still nothing on disk.
    const r2 = watcher.check();
    assert.equal(r2.kind, "unchanged");
    assert.equal(watcher.formatDirective(r2), null);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

/* ──────────────────── (b) present at start ──────────────────── */

test("FIXO.md present at start → first check is unchanged", () => {
  const cwd = mkTmp();
  try {
    writeFixoMd(cwd, "# rules\nNo writes to dist/");
    const watcher = new FixoMdWatcher(cwd);
    // Baseline was captured by the constructor; the FIRST check
    // after that must be a no-op because the system prompt already
    // contains this file.
    const r = watcher.check();
    assert.equal(r.kind, "unchanged");
    assert.equal(watcher.formatDirective(r), null);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

/* ──────────────────── (c) updated mid-run ──────────────────── */

test("FIXO.md updated mid-run → updated directive with new content", () => {
  const cwd = mkTmp();
  try {
    const p = writeFixoMd(cwd, "# rules v1\nFollow the staging guard.");
    const watcher = new FixoMdWatcher(cwd);

    // Edit the file after the watcher captured the baseline.
    fs.writeFileSync(
      p,
      "# rules v2\nNow forbid auto-generated code in src/.",
      "utf-8",
    );
    bumpMtime(p);

    const r = watcher.check();
    assert.equal(r.kind, "updated");
    const directive = watcher.formatDirective(r);
    assert.ok(directive);
    assert.match(directive!, /\[Project Instructions\]/);
    assert.match(directive!, /updated mid-run/);
    assert.match(directive!, /rules v2/);
    assert.match(directive!, /auto-generated code/);
    assert.doesNotMatch(directive!, /rules v1/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

/* ──────────────────── (d) deleted mid-run ──────────────────── */

test("FIXO.md deleted mid-run → deleted directive names previous path", () => {
  const cwd = mkTmp();
  try {
    const p = writeFixoMd(cwd, "# rules\nstaging is mandatory");
    const watcher = new FixoMdWatcher(cwd);

    fs.unlinkSync(p);

    const r = watcher.check();
    assert.equal(r.kind, "deleted");
    const directive = watcher.formatDirective(r);
    assert.ok(directive);
    assert.match(directive!, /\[Project Instructions\]/);
    assert.match(directive!, /removed mid-run/);
    assert.match(
      directive!,
      new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

/* ──────────────────── (e) created mid-run ──────────────────── */

test("FIXO.md created mid-run → created directive with the new content", () => {
  const cwd = mkTmp();
  try {
    // Empty cwd → baseline is "no file".
    const watcher = new FixoMdWatcher(cwd);

    writeFixoMd(cwd, "# new rules\nstr_replace before write_file");

    const r = watcher.check();
    assert.equal(r.kind, "created");
    const directive = watcher.formatDirective(r);
    assert.ok(directive);
    assert.match(directive!, /\[Project Instructions\]/);
    assert.match(directive!, /now available/);
    assert.match(directive!, /new rules/);
    assert.match(directive!, /str_replace before write_file/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

/* ──────────────────── (f) dedup ──────────────────── */

test("updated → unchanged dedup on the second consecutive check", () => {
  const cwd = mkTmp();
  try {
    const p = writeFixoMd(cwd, "# v1");
    const watcher = new FixoMdWatcher(cwd);

    fs.writeFileSync(p, "# v2", "utf-8");
    bumpMtime(p);

    const r1 = watcher.check();
    assert.equal(r1.kind, "updated");

    // No further edits. The next check must NOT re-announce the
    // same content as another `updated` event.
    const r2 = watcher.check();
    assert.equal(r2.kind, "unchanged");
    assert.equal(watcher.formatDirective(r2), null);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
