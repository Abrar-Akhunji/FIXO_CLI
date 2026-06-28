import assert from "node:assert/strict";
import test from "node:test";
import {
  LoopMitigationTracker,
  REPEAT_WARN_BLOCK_THRESHOLD,
  isReadTool,
  buildLoopBlockedReadResult,
} from "../runtime/loop-mitigation.js";

test("REPEAT_WARN_BLOCK_THRESHOLD is at least 2", () => {
  assert.ok(REPEAT_WARN_BLOCK_THRESHOLD >= 2);
});

test("LoopMitigationTracker: first warn does not block", () => {
  const t = new LoopMitigationTracker();
  const nowBlocking = t.recordWarn("src/foo.ts");
  assert.equal(nowBlocking, false);
  assert.equal(t.isBlocked("src/foo.ts"), false);
  assert.equal(t.warnsFor("src/foo.ts"), 1);
});

test("LoopMitigationTracker: second warn flips to blocked", () => {
  const t = new LoopMitigationTracker();
  t.recordWarn("src/foo.ts");
  const nowBlocking = t.recordWarn("src/foo.ts");
  assert.equal(nowBlocking, true);
  assert.equal(t.isBlocked("src/foo.ts"), true);
});

test("LoopMitigationTracker: third warn keeps blocked but returns false (already announced)", () => {
  const t = new LoopMitigationTracker();
  t.recordWarn("src/foo.ts");
  t.recordWarn("src/foo.ts");
  const nowBlocking = t.recordWarn("src/foo.ts");
  assert.equal(nowBlocking, false);
  assert.equal(t.isBlocked("src/foo.ts"), true);
  assert.equal(t.warnsFor("src/foo.ts"), 3);
});

test("LoopMitigationTracker: per-target isolation", () => {
  const t = new LoopMitigationTracker();
  t.recordWarn("src/a.ts");
  t.recordWarn("src/a.ts");
  assert.equal(t.isBlocked("src/a.ts"), true);
  assert.equal(t.isBlocked("src/b.ts"), false);
});

test("LoopMitigationTracker: reset clears state", () => {
  const t = new LoopMitigationTracker();
  t.recordWarn("src/foo.ts");
  t.recordWarn("src/foo.ts");
  t.reset();
  assert.equal(t.isBlocked("src/foo.ts"), false);
  assert.equal(t.warnsFor("src/foo.ts"), 0);
});

test("isReadTool classifies read-shaped tools", () => {
  for (const name of ["read_file", "extract_symbols", "extract_imports"]) {
    assert.equal(isReadTool(name), true, `'${name}' should be a read`);
  }
});

test("isReadTool rejects non-read tools", () => {
  for (const name of ["write_file", "run_command", "search_code", "list_dir"]) {
    assert.equal(isReadTool(name), false, `'${name}' should not be a read`);
  }
});

test("buildLoopBlockedReadResult produces a clear tool-error string", () => {
  const msg = buildLoopBlockedReadResult("src/foo.ts", 4);
  assert.match(msg, /Error: read_file refused/);
  assert.match(msg, /src\/foo\.ts/);
  assert.match(msg, /4 consecutive warnings/);
  assert.match(msg, /search_code|extract_imports|clarifying question/);
});

// ── Phase 1b sliding-window tests ──────────────────────────────────────────

test("Sliding mode: warns within window cause block", () => {
  const t = new LoopMitigationTracker({
    useSlidingWindow: true,
    blockWindowTurns: 10,
  });
  t.recordWarn("src/foo.ts", 1);
  assert.equal(t.isBlocked("src/foo.ts", 1), false);
  t.recordWarn("src/foo.ts", 2);
  assert.equal(t.isBlocked("src/foo.ts", 2), true);
});

test("Sliding mode: warns outside window decay → block lifts", () => {
  const t = new LoopMitigationTracker({
    useSlidingWindow: true,
    blockWindowTurns: 10,
  });
  t.recordWarn("src/foo.ts", 1);
  t.recordWarn("src/foo.ts", 2);
  assert.equal(t.isBlocked("src/foo.ts", 2), true);
  // Advance past the window — both warns are now too old to count.
  assert.equal(t.isBlocked("src/foo.ts", 20), false);
});

test("Sliding mode: third warn inside window keeps block; fourth outside re-blocks only with another fresh warn", () => {
  const t = new LoopMitigationTracker({
    useSlidingWindow: true,
    blockWindowTurns: 5,
  });
  t.recordWarn("src/foo.ts", 1);
  t.recordWarn("src/foo.ts", 2);
  assert.equal(t.isBlocked("src/foo.ts", 3), true);
  // Move past the window. Old warns expire.
  assert.equal(t.isBlocked("src/foo.ts", 10), false);
  // Now record fresh warns — block returns only at threshold.
  t.recordWarn("src/foo.ts", 11);
  assert.equal(t.isBlocked("src/foo.ts", 11), false);
  t.recordWarn("src/foo.ts", 12);
  assert.equal(t.isBlocked("src/foo.ts", 12), true);
});

test("Sliding mode: warnsFor returns count within window", () => {
  const t = new LoopMitigationTracker({
    useSlidingWindow: true,
    blockWindowTurns: 5,
  });
  t.recordWarn("src/foo.ts", 1);
  t.recordWarn("src/foo.ts", 2);
  t.recordWarn("src/foo.ts", 3);
  // Within window (turn 5): all three warns live.
  assert.equal(t.warnsFor("src/foo.ts", 5), 3);
  // Far outside window: zero.
  assert.equal(t.warnsFor("src/foo.ts", 20), 0);
});

test("Sliding mode: reset(target) clears just that target", () => {
  const t = new LoopMitigationTracker({
    useSlidingWindow: true,
    blockWindowTurns: 10,
  });
  t.recordWarn("src/a.ts", 1);
  t.recordWarn("src/a.ts", 2);
  t.recordWarn("src/b.ts", 1);
  t.recordWarn("src/b.ts", 2);
  assert.equal(t.isBlocked("src/a.ts", 3), true);
  assert.equal(t.isBlocked("src/b.ts", 3), true);
  t.reset("src/a.ts");
  assert.equal(t.isBlocked("src/a.ts", 3), false);
  // b is untouched
  assert.equal(t.isBlocked("src/b.ts", 3), true);
});

test("Sliding mode: missing currentTurn on recordWarn falls back to legacy semantics", () => {
  // Defensive — callers that haven't been updated still increment a count.
  const t = new LoopMitigationTracker({
    useSlidingWindow: true,
    blockWindowTurns: 10,
  });
  t.recordWarn("src/foo.ts");
  t.recordWarn("src/foo.ts");
  // Legacy fallback path should flip the block on second warn.
  assert.equal(t.isBlocked("src/foo.ts"), true);
});

// Replays the deadlock observed in the June 22, 2026 log session.
test("Sliding mode: replays the immortal-file deadlock and proves it no longer occurs", () => {
  // Same shape as the log: style.css gets 2 warns at turns 4 and 7.
  // Under legacy: blocked for the rest of the session → user can't
  // even rename or delete the file.
  // Under sliding window 10: block lifts by turn 18 even with no
  // further intervention.
  const t = new LoopMitigationTracker({
    useSlidingWindow: true,
    blockWindowTurns: 10,
  });
  t.recordWarn("test folder/style.css", 4);
  t.recordWarn("test folder/style.css", 7);
  assert.equal(t.isBlocked("test folder/style.css", 8), true);
  assert.equal(t.isBlocked("test folder/style.css", 10), true);
  // Window decays — by turn 18, warn at turn 7 is the most recent
  // and at cutoff (18 - 10 = 8); warn at 4 is gone, warn at 7 is gone too.
  assert.equal(t.isBlocked("test folder/style.css", 18), false);
});

// ── Backward-compat assertions: legacy mode is unchanged ──────────────────

test("Legacy mode default (no options): behaves exactly as pre-Phase-1b", () => {
  const t = new LoopMitigationTracker();
  // Pass turns — should be ignored in legacy mode.
  assert.equal(t.recordWarn("src/foo.ts", 999), false);
  assert.equal(t.recordWarn("src/foo.ts", 1), true);
  // Far-future turn does NOT lift the block in legacy mode.
  assert.equal(t.isBlocked("src/foo.ts", 1_000_000), true);
});
