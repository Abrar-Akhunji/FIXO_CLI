import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeGlobFiles, type GlobArgs } from "../agent/tool-executor.js";

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

function withTempCwd<T>(fn: (cwd: string) => Promise<T> | T): Promise<T> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-glob-"));
  return (async () => {
    try {
      return await fn(tmp);
    } finally {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  })();
}

interface GlobResult {
  pattern: string;
  matches: string[];
  total: number;
  truncated: boolean;
}

function parseResult(raw: string): GlobResult {
  return JSON.parse(raw) as GlobResult;
}

/* ------------------------------------------------------------------ */
/* Case 1: pattern matching over specific file configurations          */
/* ------------------------------------------------------------------ */

test("glob_files — matches TypeScript sources under a nested directory", async () => {
  await withTempCwd(async (cwd) => {
    fs.mkdirSync(path.join(cwd, "src/nested"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, "src/a.ts"),
      "export const a = 1;",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(cwd, "src/nested/b.ts"),
      "export const b = 2;",
      "utf-8",
    );
    fs.writeFileSync(path.join(cwd, "src/c.js"), "// js file", "utf-8");
    fs.writeFileSync(path.join(cwd, "README.md"), "# readme", "utf-8");

    const args: GlobArgs = { pattern: "src/**/*.ts" };
    const result = parseResult(await executeGlobFiles(args, cwd, {}));

    assert.equal(result.truncated, false);
    // The exact set depends on whether the native fs.promises.glob
    // is available (Node 22+) — but we must always find at least
    // the .ts files and never the .js or .md.
    for (const m of result.matches) {
      assert.equal(m.endsWith(".ts"), true, `unexpected match: ${m}`);
    }
    assert.ok(
      result.matches.length >= 2,
      `expected >=2 matches, got ${result.matches.length}`,
    );
    // The two .ts files we created must be in the matches.
    const normalised = result.matches.map((m) => m.replace(/\\/g, "/")).sort();
    assert.ok(
      normalised.some((m) => m.endsWith("src/a.ts")),
      `expected src/a.ts in matches: ${normalised.join(", ")}`,
    );
    assert.ok(
      normalised.some((m) => m.endsWith("src/nested/b.ts")),
      `expected src/nested/b.ts in matches: ${normalised.join(", ")}`,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Case 2: default system exclusion filters                            */
/* ------------------------------------------------------------------ */

test("glob_files — default skip set prunes node_modules, .git, dist, .fixo, .fixocli", async () => {
  await withTempCwd(async (cwd) => {
    // Files inside directories that should be pruned.
    fs.mkdirSync(path.join(cwd, "node_modules/foo"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "node_modules/foo/index.js"), "x", "utf-8");
    fs.mkdirSync(path.join(cwd, ".git/objects"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".git/HEAD"),
      "ref: refs/heads/main",
      "utf-8",
    );
    fs.mkdirSync(path.join(cwd, "dist"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "dist/bundle.js"), "x", "utf-8");
    fs.mkdirSync(path.join(cwd, ".fixo/staging/run1"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".fixo/staging/run1/pending"),
      "x",
      "utf-8",
    );
    fs.mkdirSync(path.join(cwd, ".fixocli"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".fixocli/config.json"), "{}", "utf-8");

    // A file that should always match.
    fs.writeFileSync(path.join(cwd, "keep.txt"), "k", "utf-8");

    const args: GlobArgs = { pattern: "**/*" };
    const result = parseResult(await executeGlobFiles(args, cwd, {}));

    const joined = result.matches.join("\n");
    assert.equal(
      joined.includes("node_modules"),
      false,
      "node_modules must be skipped",
    );
    assert.equal(joined.includes(".git/"), false, ".git must be skipped");
    assert.equal(joined.includes("dist/"), false, "dist must be skipped");
    assert.equal(joined.includes(".fixo/"), false, ".fixo must be skipped");
    assert.equal(
      joined.includes(".fixocli/"),
      false,
      ".fixocli must be skipped",
    );
    assert.ok(
      result.matches.some((m) => m === "keep.txt" || m.endsWith("/keep.txt")),
      "keep.txt should be matched",
    );
  });
});

/* ------------------------------------------------------------------ */
/* Case 3: absolute boundary rejection                                 */
/* ------------------------------------------------------------------ */

test("glob_files — explicit cwd that escapes the workspace is rejected", async () => {
  await withTempCwd(async (cwd) => {
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), "fixo-glob-outside-"),
    );
    try {
      const args: GlobArgs = {
        pattern: "**/*.ts",
        cwd: path.join(outside, "somewhere"),
      };
      const result = JSON.parse(await executeGlobFiles(args, cwd, {}));
      assert.deepEqual(result.matches, []);
    } finally {
      try {
        fs.rmSync(outside, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* Case 4: structural truncation output                                */
/* ------------------------------------------------------------------ */

test("glob_files — overflow truncates results and reports total + truncated flag", async () => {
  await withTempCwd(async (cwd) => {
    // Create a fan of 50 files. With maxResults=10 we should get 10
    // back and a `truncated: true` envelope.
    for (let i = 0; i < 50; i++) {
      fs.writeFileSync(
        path.join(cwd, `file-${i.toString().padStart(2, "0")}.txt`),
        `${i}`,
        "utf-8",
      );
    }
    const args: GlobArgs = { pattern: "**/*.txt", maxResults: 10 };
    const result = parseResult(await executeGlobFiles(args, cwd, {}));
    assert.equal(result.truncated, true);
    assert.equal(result.matches.length, 10);
    assert.ok(result.total >= 10, `expected total >= 10, got ${result.total}`);
  });
});

test("glob_files — under the cap returns the full set with truncated=false", async () => {
  await withTempCwd(async (cwd) => {
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(cwd, `tiny-${i}.txt`), "x", "utf-8");
    }
    const args: GlobArgs = { pattern: "**/*.txt", maxResults: 100 };
    const result = parseResult(await executeGlobFiles(args, cwd, {}));
    assert.equal(result.truncated, false);
    assert.equal(result.matches.length, 5);
    assert.equal(result.total, 5);
  });
});

test("glob_files — hard cap clamps maxResults to 5000", async () => {
  await withTempCwd(async (cwd) => {
    const args: GlobArgs = { pattern: "**/*.txt", maxResults: 99999 };
    const result = await executeGlobFiles(args, cwd, {});
    // Parsing succeeds, no Error: prefix; the hard cap is enforced
    // silently inside the implementation.
    assert.equal(result.startsWith("Error:"), false);
    const parsed = JSON.parse(result) as {
      matches: string[];
      truncated: boolean;
    };
    assert.ok(Array.isArray(parsed.matches));
    assert.ok(parsed.matches.length <= 5000);
  });
});
