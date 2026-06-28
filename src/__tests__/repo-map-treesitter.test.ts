/**
 * repo-map-treesitter.test.ts — Phase 3.1 acceptance test.
 *
 * Proves the contract: when the vendored tree-sitter WASM grammars
 * are present (the npm package ships them; CI gates the publish on
 * their presence), `buildRepoMap` extracts top-level symbol names
 * for TypeScript, JavaScript, Python, Go, and Rust files via real
 * AST traversal — not by regex.
 *
 * The Rust case is the most concrete proof that this is more than
 * a cosmetic refactor: the pre-Phase-3.1 inline regex did not
 * recognise Rust at all, so the rust-fixture exports list goes
 * from `[]` to a real set of names.
 *
 * Each case builds a tiny temp workspace, runs `buildRepoMap`, and
 * asserts the rendered map mentions the expected exports.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildRepoMap } from "../agent/repo-map.js";
import { ParserFactory } from "../agent/parser-adapter.js";

function mkWorkspace(files: Record<string, string>): {
  cwd: string;
  cleanup: () => void;
} {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-repo-map-ts-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(cwd, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf-8");
  }
  return {
    cwd,
    cleanup: () => {
      try {
        fs.rmSync(cwd, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

test("buildRepoMap — TypeScript: extracts exported classes, functions, interfaces, types, enums, consts", async () => {
  const ws = mkWorkspace({
    "src/lib.ts": `
export class Cache {}
export interface Options {}
export type Id = string;
export enum Status { Ok, Err }
export const VERSION = '1.0';
export async function load() {}
class NotExported {}
const alsoNotExported = 1;
`,
  });
  try {
    ParserFactory.reset();
    const map = await buildRepoMap(ws.cwd);
    for (const name of [
      "Cache",
      "Options",
      "Id",
      "Status",
      "VERSION",
      "load",
    ]) {
      assert.match(
        map,
        new RegExp(`\\b${name}\\b`),
        `expected ${name} in map, got:\n${map}`,
      );
    }
    assert.equal(
      map.includes("NotExported"),
      false,
      "non-exported symbol must not appear",
    );
    assert.equal(
      map.includes("alsoNotExported"),
      false,
      "non-exported const must not appear",
    );
  } finally {
    ws.cleanup();
    ParserFactory.reset();
  }
});

test("buildRepoMap — Python: extracts top-level def/class names that do not start with underscore", async () => {
  const ws = mkWorkspace({
    "app.py": `
class PublicCls:
    pass

def public_fn():
    pass

class _PrivateCls:
    pass

def _private_fn():
    pass
`,
  });
  try {
    ParserFactory.reset();
    const map = await buildRepoMap(ws.cwd);
    assert.match(map, /\bPublicCls\b/);
    assert.match(map, /\bpublic_fn\b/);
    assert.equal(
      map.includes("_PrivateCls"),
      false,
      "private class must be filtered out",
    );
    assert.equal(
      map.includes("_private_fn"),
      false,
      "private function must be filtered out",
    );
  } finally {
    ws.cleanup();
    ParserFactory.reset();
  }
});

test("buildRepoMap — Go: extracts capitalized (exported) top-level funcs and types", async () => {
  const ws = mkWorkspace({
    "pkg.go": `package pkg

func ExportedFn() {}
func unexportedFn() {}

type ExportedStruct struct{}
type unexportedStruct struct{}

type ExportedIface interface{}
`,
  });
  try {
    ParserFactory.reset();
    const map = await buildRepoMap(ws.cwd);
    assert.match(map, /\bExportedFn\b/);
    assert.match(map, /\bExportedStruct\b/);
    assert.match(map, /\bExportedIface\b/);
    assert.equal(
      map.includes("unexportedFn"),
      false,
      "lowercase Go func must not be marked exported",
    );
    assert.equal(
      map.includes("unexportedStruct"),
      false,
      "lowercase Go struct must not be marked exported",
    );
  } finally {
    ws.cleanup();
    ParserFactory.reset();
  }
});

test("buildRepoMap — Rust: extracts pub items (previously unsupported by the inline regex)", async () => {
  const ws = mkWorkspace({
    "lib.rs": `
pub fn build() {}
fn internal() {}
pub struct Config {}
struct Internal {}
pub enum Mode { Fast, Heavy }
pub trait Strategy {}
pub const VERSION: &str = "1.0";
`,
  });
  try {
    ParserFactory.reset();
    const map = await buildRepoMap(ws.cwd);
    // This is the headline assertion: pre-Phase-3.1 had no Rust path
    // at all, so all four names would have been absent.
    assert.match(map, /\bbuild\b/);
    assert.match(map, /\bConfig\b/);
    assert.match(map, /\bMode\b/);
    assert.match(map, /\bStrategy\b/);
    assert.match(map, /\bVERSION\b/);
    assert.equal(
      map.includes("internal"),
      false,
      "non-pub Rust fn must not appear",
    );
    assert.equal(
      map.includes("Internal"),
      false,
      "non-pub Rust struct must not appear",
    );
  } finally {
    ws.cleanup();
    ParserFactory.reset();
  }
});

test("buildRepoMap — multi-language workspace: independent extraction per file", async () => {
  const ws = mkWorkspace({
    "mod.ts": `export class TsClass {}\nexport const tsConst = 1;\n`,
    "mod.py": `class PyClass:\n    pass\n\ndef py_fn():\n    pass\n`,
    "mod.go": `package main\nfunc GoFn() {}\ntype GoType struct{}\n`,
    "mod.rs": `pub fn rs_fn() {}\npub struct RsStruct {}\n`,
  });
  try {
    ParserFactory.reset();
    const map = await buildRepoMap(ws.cwd);
    for (const name of [
      "TsClass",
      "tsConst",
      "PyClass",
      "py_fn",
      "GoFn",
      "GoType",
      "rs_fn",
      "RsStruct",
    ]) {
      assert.match(
        map,
        new RegExp(`\\b${name}\\b`),
        `expected ${name} in multi-lang map`,
      );
    }
  } finally {
    ws.cleanup();
    ParserFactory.reset();
  }
});
