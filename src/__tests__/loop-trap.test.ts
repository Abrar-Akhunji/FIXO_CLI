import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LoopTrapDetector,
  LoopTrapAbortedError,
  DEFAULT_LOOP_TRAP_PREFS,
  canonicaliseArgs,
  type LoopSnapshot,
} from "../runtime/loop-trap.js";

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

function withTempCwd<T>(fn: (cwd: string) => Promise<T> | T): Promise<T> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-loop-trap-"));
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

function snapshotAt(
  turnIndex: number,
  callArgs: Record<string, unknown>,
  result: string,
  workspaceFingerprint: string,
): LoopSnapshot {
  const detector = new LoopTrapDetector();
  return {
    turnIndex,
    toolCallFingerprint: detector.fingerprintToolCall(callArgs),
    toolResultFingerprint: detector.fingerprintToolResult(result),
    workspaceFingerprint,
    ts: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* canonicaliseArgs                                                   */
/* ------------------------------------------------------------------ */

test("canonicaliseArgs — key order does not affect output", () => {
  const a = canonicaliseArgs({ a: 1, b: 2, c: 3 });
  const b = canonicaliseArgs({ c: 3, a: 1, b: 2 });
  assert.equal(a, b);
});

test("canonicaliseArgs — drops undefined values", () => {
  const a = canonicaliseArgs({ a: 1, b: undefined });
  const b = canonicaliseArgs({ a: 1 });
  assert.equal(a, b);
});

/* ------------------------------------------------------------------ */
/* fingerprintToolCall / fingerprintToolResult                        */
/* ------------------------------------------------------------------ */

test("fingerprintToolCall — identical args produce identical fingerprints", () => {
  const d = new LoopTrapDetector();
  const f1 = d.fingerprintToolCall({ file: "a.ts", line: 12 });
  const f2 = d.fingerprintToolCall({ line: 12, file: "a.ts" });
  assert.equal(f1, f2);
  assert.equal(f1.length, 64);
});

test("fingerprintToolResult — tail truncation is stable", () => {
  const d = new LoopTrapDetector({
    ...DEFAULT_LOOP_TRAP_PREFS,
    toolResultTailBytes: 64,
  });
  const tail = "X".repeat(64);
  const long = "a".repeat(200) + tail;
  const shorter = "b".repeat(200) + tail;
  // Both should hash only the last 64 bytes -> the shared tail.
  assert.equal(d.fingerprintToolResult(long), d.fingerprintToolResult(shorter));
});

/* ------------------------------------------------------------------ */
/* fingerprintWorkspace                                                */
/* ------------------------------------------------------------------ */

test("fingerprintWorkspace — excludes .fixo, .git, node_modules", async () => {
  await withTempCwd(async (cwd) => {
    fs.writeFileSync(path.join(cwd, "a.ts"), "export const a = 1;");
    fs.mkdirSync(path.join(cwd, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "node_modules", "junk.js"), "junk");
    fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".git", "config"), "junk");
    fs.mkdirSync(path.join(cwd, ".fixo"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".fixo", "state.json"), "junk");
    const d = new LoopTrapDetector();
    const fp = await d.fingerprintWorkspace(cwd);
    assert.equal(fp.length, 64);
    // Changing a tracked file should change the fingerprint
    fs.writeFileSync(path.join(cwd, "a.ts"), "export const a = 2;");
    const fp2 = await d.fingerprintWorkspace(cwd);
    assert.notEqual(fp, fp2);
  });
});

test("fingerprintWorkspace — extraExclude filters additional paths", async () => {
  await withTempCwd(async (cwd) => {
    fs.writeFileSync(path.join(cwd, "src.ts"), "x");
    fs.mkdirSync(path.join(cwd, "scratch"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "scratch", "tmp.ts"), "y");
    const d = new LoopTrapDetector();
    // Compute baseline with scratch excluded; then change scratch
    // contents; the fingerprint must stay identical because the
    // excluded directory is invisible to the walk.
    const fp1 = await d.fingerprintWorkspace(cwd, ["scratch"]);
    fs.writeFileSync(path.join(cwd, "scratch", "tmp.ts"), "y-changed");
    const fp2 = await d.fingerprintWorkspace(cwd, ["scratch"]);
    assert.equal(fp1, fp2);
    // Sanity: the same change with scratch visible should move the
    // fingerprint, proving the baseline was meaningful.
    const fp3 = await d.fingerprintWorkspace(cwd);
    assert.notEqual(fp1, fp3);
  });
});

/* ------------------------------------------------------------------ */
/* record / verdict transitions                                        */
/* ------------------------------------------------------------------ */

test("record — first turn is always ok", () => {
  const d = new LoopTrapDetector();
  const ws = "w0";
  const v = d.record(snapshotAt(0, { file: "a" }, "result", ws));
  assert.equal(v.state, "ok");
});

test("record — two equivalent turns do not trip the trigger", () => {
  const d = new LoopTrapDetector();
  const ws = "w0";
  d.record(snapshotAt(0, { file: "a" }, "result", ws));
  const v = d.record(snapshotAt(1, { file: "a" }, "result", ws));
  assert.equal(v.state, "ok");
});

test("record — three equivalent turns return trap-detected with layers", () => {
  const d = new LoopTrapDetector();
  const ws = "w0";
  d.record(snapshotAt(0, { file: "a" }, "result", ws));
  d.record(snapshotAt(1, { file: "a" }, "result", ws));
  const v = d.record(snapshotAt(2, { file: "a" }, "result", ws));
  assert.equal(v.state, "trap-detected");
  if (v.state === "trap-detected") {
    assert.equal(v.consecutiveCount, 3);
    assert.deepEqual([...v.layers].sort(), [
      "tool-args",
      "tool-result",
      "workspace",
    ]);
    assert.equal(v.turnIndex, 2);
  }
});

test("record — six equivalent turns return hard-abort", () => {
  const d = new LoopTrapDetector();
  const ws = "w0";
  for (let i = 0; i < 5; i++) {
    d.record(snapshotAt(i, { file: "a" }, "result", ws));
  }
  const v = d.record(snapshotAt(5, { file: "a" }, "result", ws));
  assert.equal(v.state, "hard-abort");
  if (v.state === "hard-abort") {
    assert.equal(v.consecutiveCount, 6);
  }
});

test("record — diverging turn resets the consecutive counter", () => {
  const d = new LoopTrapDetector();
  d.record(snapshotAt(0, { file: "a" }, "result", "w0"));
  d.record(snapshotAt(1, { file: "a" }, "result", "w0"));
  d.record(snapshotAt(2, { file: "a" }, "result", "w0")); // trap-detected
  const v = d.record(snapshotAt(3, { file: "b" }, "diverging-result", "w0"));
  assert.equal(v.state, "ok");
});

test("record — only one layer matching does not trip trap", () => {
  const d = new LoopTrapDetector();
  d.record(snapshotAt(0, { file: "a" }, "r1", "w0"));
  d.record(snapshotAt(1, { file: "a" }, "r2", "w1"));
  d.record(snapshotAt(2, { file: "a" }, "r3", "w2"));
  const v = d.record(snapshotAt(3, { file: "a" }, "r4", "w3"));
  assert.equal(v.state, "ok");
});

/* ------------------------------------------------------------------ */
/* error shape / history bound / planner re-export sanity              */
/* ------------------------------------------------------------------ */

test("LoopTrapAbortedError — carries fingerprint and count", () => {
  const err = new LoopTrapAbortedError("abc123", 6);
  assert.equal(err.name, "LoopTrapAbortedError");
  assert.equal(err.compositeFingerprint, "abc123");
  assert.equal(err.consecutiveCount, 6);
  assert.match(err.message, /Loop-trap hard-abort/);
});

// Phase 4.3 — the `planner.ts` re-export façade has been removed.
// The previous "planner re-exports LoopTrapDetector surface" test
// is intentionally deleted: the contract it asserted no longer
// exists by design (the façade had zero live consumers and
// reverse-coupled planner.ts to an unrelated runtime concern).
// Callers that need the detector import from '../runtime/loop-trap.js'.
