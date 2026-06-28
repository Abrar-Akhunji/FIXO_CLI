/**
 * Tests for the hook engine (§3.4).
 *
 * We exercise the full pipeline: load .fixo/hooks.json, fire
 * a hook, parse the JSON payload, apply the decision. Hooks
 * are real OS processes (we spawn `node` with `-e`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyModifiedArgs,
  fireHooks,
  getHooksPath,
  loadHooksFile,
  saveHooksFile,
  type HooksFile,
} from "../agent/hooks.js";

function mkTmpCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hooks-test-"));
}

/** A tiny node script that reads stdin and writes JSON to stdout. */
function nodeScript(body: string): string {
  return `node -e ${JSON.stringify(
    `let data = ''; process.stdin.on('data', c => data += c); process.stdin.on('end', () => { try { const p = JSON.parse(data); (${body})(p); } catch (e) { process.exit(2); } });`,
  )}`;
}

test("loadHooksFile returns null when .fixo/hooks.json is absent", () => {
  const cwd = mkTmpCwd();
  try {
    assert.equal(loadHooksFile(cwd), null);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("saveHooksFile + loadHooksFile roundtrip preserves the spec", () => {
  const cwd = mkTmpCwd();
  try {
    const file: HooksFile = {
      version: 1,
      hooks: [
        {
          id: "demo-pre",
          event: "PreToolUse",
          command: "node",
          args: ["-e", "process.exit(0)"],
        },
      ],
    };
    const r = saveHooksFile(cwd, file);
    assert.equal(r.ok, true);
    const loaded = loadHooksFile(cwd);
    assert.ok(loaded);
    assert.equal(loaded?.hooks.length, 1);
    assert.equal(loaded?.hooks[0].id, "demo-pre");
    assert.equal(loaded?.hooks[0].event, "PreToolUse");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("loadHooksFile returns null on malformed JSON", () => {
  const cwd = mkTmpCwd();
  try {
    fs.mkdirSync(path.join(cwd, ".fixo"), { recursive: true });
    fs.writeFileSync(getHooksPath(cwd), "{not-json");
    assert.equal(loadHooksFile(cwd), null);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("loadHooksFile returns null on wrong version", () => {
  const cwd = mkTmpCwd();
  try {
    saveHooksFile(cwd, { version: 2, hooks: [] } as unknown as HooksFile);
    assert.equal(loadHooksFile(cwd), null);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("fireHooks with no hooks file returns fired=false, allow", () => {
  const cwd = mkTmpCwd();
  try {
    const r = fireHooks(cwd, "PreToolUse", {
      tool: "write_file",
      args: { path: "a.ts" },
      sessionId: "sess-1",
    });
    assert.equal(r.fired, false);
    assert.equal(r.decision, "allow");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("fireHooks PreToolUse with allow hook passes through", () => {
  const cwd = mkTmpCwd();
  try {
    saveHooksFile(cwd, {
      version: 1,
      hooks: [
        {
          id: "silent",
          event: "PreToolUse",
          command: "node",
          args: ["-e", "process.exit(0)"],
        },
      ],
    });
    const r = fireHooks(cwd, "PreToolUse", {
      tool: "write_file",
      args: { path: "a.ts" },
      sessionId: "sess-1",
    });
    assert.equal(r.fired, true);
    assert.equal(r.decision, "allow");
    assert.equal(r.hookId, "silent");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("fireHooks PreToolUse with deny hook short-circuits", () => {
  const cwd = mkTmpCwd();
  try {
    saveHooksFile(cwd, {
      version: 1,
      hooks: [
        {
          id: "blocker",
          event: "PreToolUse",
          command: "node",
          args: [
            "-e",
            'process.stdout.write(JSON.stringify({decision:"deny",reason:"no touch"}))',
          ],
        },
      ],
    });
    const r = fireHooks(cwd, "PreToolUse", {
      tool: "write_file",
      args: { path: "a.ts" },
      sessionId: "sess-1",
    });
    assert.equal(r.fired, true);
    assert.equal(r.decision, "deny");
    assert.equal(r.reason, "no touch");
    assert.equal(r.hookId, "blocker");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("fireHooks PreToolUse with modify hook returns modifiedArgs", () => {
  const cwd = mkTmpCwd();
  try {
    saveHooksFile(cwd, {
      version: 1,
      hooks: [
        {
          id: "redactor",
          event: "PreToolUse",
          command: "node",
          args: [
            "-e",
            'process.stdout.write(JSON.stringify({decision:"modify",modifiedArgs:{path:"b.ts"}}))',
          ],
        },
      ],
    });
    const r = fireHooks(cwd, "PreToolUse", {
      tool: "write_file",
      args: { path: "a.ts" },
      sessionId: "sess-1",
    });
    assert.equal(r.fired, true);
    assert.equal(r.decision, "modify");
    assert.deepEqual(r.modifiedArgs, { path: "b.ts" });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("fireHooks sends JSON payload {event, tool, args, sessionId, cwd} to hook stdin", () => {
  const cwd = mkTmpCwd();
  const captured = path.join(cwd, "captured.json");
  try {
    saveHooksFile(cwd, {
      version: 1,
      hooks: [
        {
          id: "cap",
          event: "PreToolUse",
          command: "node",
          args: [
            "-e",
            `let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{ require('fs').writeFileSync(${JSON.stringify(captured)}, d); });`,
          ],
        },
      ],
    });
    fireHooks(cwd, "PreToolUse", {
      tool: "write_file",
      args: { path: "a.ts", content: "x" },
      sessionId: "sess-X",
    });
    const captured_json = JSON.parse(fs.readFileSync(captured, "utf-8"));
    assert.equal(captured_json.event, "PreToolUse");
    assert.equal(captured_json.tool, "write_file");
    assert.equal(captured_json.sessionId, "sess-X");
    assert.deepEqual(captured_json.args, { path: "a.ts", content: "x" });
    assert.equal(captured_json.cwd, cwd);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("fireHooks treats non-zero exit as deny with reason", () => {
  const cwd = mkTmpCwd();
  try {
    saveHooksFile(cwd, {
      version: 1,
      hooks: [
        {
          id: "crash",
          event: "PreToolUse",
          command: "node",
          args: ["-e", "process.exit(7)"],
        },
      ],
    });
    const r = fireHooks(cwd, "PreToolUse", {
      tool: "write_file",
      args: {},
      sessionId: "s1",
    });
    assert.equal(r.decision, "deny");
    assert.match(r.reason ?? "", /exited with status 7/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("fireHooks honours timeoutMs", () => {
  const cwd = mkTmpCwd();
  try {
    saveHooksFile(cwd, {
      version: 1,
      hooks: [
        {
          id: "sleeper",
          event: "PreToolUse",
          command: "node",
          args: ["-e", "setTimeout(()=>process.exit(0), 5000)"],
          timeoutMs: 200,
        },
      ],
    });
    const r = fireHooks(cwd, "PreToolUse", {
      tool: "write_file",
      args: {},
      sessionId: "s1",
    });
    // Timeout fires synchronously via spawnSync timeout; exit
    // status is non-zero, so we get a deny.
    assert.equal(r.decision, "deny");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("fireHooks first deny in chain short-circuits the rest", () => {
  const cwd = mkTmpCwd();
  const laterRan = path.join(cwd, "later-ran");
  try {
    saveHooksFile(cwd, {
      version: 1,
      hooks: [
        {
          id: "first-deny",
          event: "PreToolUse",
          command: "node",
          args: [
            "-e",
            'process.stdout.write(JSON.stringify({decision:"deny",reason:"first"}))',
          ],
        },
        {
          id: "later",
          event: "PreToolUse",
          command: "node",
          args: [
            "-e",
            `require('fs').writeFileSync(${JSON.stringify(laterRan)}, 'x');`,
          ],
        },
      ],
    });
    const r = fireHooks(cwd, "PreToolUse", {
      tool: "write_file",
      args: {},
      sessionId: "s1",
    });
    assert.equal(r.decision, "deny");
    assert.equal(r.reason, "first");
    assert.equal(
      fs.existsSync(laterRan),
      false,
      "later hook should not have run",
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("fireHooks only runs hooks for the requested event", () => {
  const cwd = mkTmpCwd();
  try {
    saveHooksFile(cwd, {
      version: 1,
      hooks: [
        {
          id: "post-only",
          event: "PostToolUse",
          command: "node",
          args: [
            "-e",
            'process.stdout.write(JSON.stringify({decision:"deny"}))',
          ],
        },
      ],
    });
    const r = fireHooks(cwd, "PreToolUse", {
      tool: "write_file",
      args: {},
      sessionId: "s1",
    });
    assert.equal(
      r.fired,
      false,
      "PostToolUse hook should not fire on PreToolUse event",
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("fireHooks with enabled=false hook skips it", () => {
  const cwd = mkTmpCwd();
  try {
    saveHooksFile(cwd, {
      version: 1,
      hooks: [
        {
          id: "off",
          event: "PreToolUse",
          command: "node",
          args: [
            "-e",
            'process.stdout.write(JSON.stringify({decision:"deny"}))',
          ],
          enabled: false,
        },
      ],
    });
    const r = fireHooks(cwd, "PreToolUse", {
      tool: "write_file",
      args: {},
      sessionId: "s1",
    });
    assert.equal(r.fired, false);
    assert.equal(r.decision, "allow");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("applyModifiedArgs passes through when all path fields are relative", () => {
  const cwd = mkTmpCwd();
  try {
    const r = applyModifiedArgs(cwd, { path: "a.ts" }, { path: "b.ts" });
    assert.equal(r.ok, true);
    assert.deepEqual(r.args, { path: "b.ts" });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("applyModifiedArgs rejects modifiedArgs with out-of-workspace absolute path", () => {
  const cwd = mkTmpCwd();
  try {
    const r = applyModifiedArgs(cwd, { path: "a.ts" }, { path: "/etc/passwd" });
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /out-of-workspace/);
    assert.deepEqual(
      r.args,
      { path: "a.ts" },
      "should fall back to original args",
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("applyModifiedArgs allows modifiedArgs with absolute path inside workspace", () => {
  const cwd = mkTmpCwd();
  try {
    const insideAbs = path.join(cwd, "sub", "a.ts");
    const r = applyModifiedArgs(cwd, { path: "a.ts" }, { path: insideAbs });
    assert.equal(r.ok, true);
    assert.deepEqual(r.args, { path: insideAbs });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

/* ──────── Integration: hooks wired into executeTool ──────── */

import { executeTool } from "../agent/tool-executor.js";

test("executeTool: PreToolUse hook with deny decision blocks the call (PRD §5.7)", async () => {
  const cwd = mkTmpCwd();
  try {
    saveHooksFile(cwd, {
      version: 1,
      hooks: [
        {
          id: "block-write",
          event: "PreToolUse",
          command: "node",
          args: [
            "-e",
            'process.stdout.write(JSON.stringify({decision:"deny",reason:"no writes allowed"}))',
          ],
        },
      ],
    });
    // `write_file` is a mutation tool. The hook should fire
    // and the dispatcher should return a denial without
    // actually performing the write.
    const event = await executeTool(
      "write_file",
      { path: "a.ts", content: "x" },
      cwd,
    );
    assert.equal(event.tool, "write_file");
    assert.match(event.result, /hook denied/);
    assert.match(event.result, /no writes allowed/);
    // The file must NOT have been created on disk.
    assert.equal(fs.existsSync(path.join(cwd, "a.ts")), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("executeTool: PreToolUse hook with allow lets the call proceed", async () => {
  const cwd = mkTmpCwd();
  try {
    saveHooksFile(cwd, {
      version: 1,
      hooks: [
        {
          id: "silent",
          event: "PreToolUse",
          command: "node",
          args: ["-e", "process.exit(0)"],
        },
      ],
    });
    const event = await executeTool(
      "write_file",
      { path: "a.ts", content: "x" },
      cwd,
    );
    // write_file without session may require config; just
    // assert the result does NOT start with "Error: hook".
    assert.ok(!/hook denied/i.test(event.result));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("executeTool: no hooks file → calls proceed as before", async () => {
  const cwd = mkTmpCwd();
  try {
    // No saveHooksFile call → no hooks to fire.
    const event = await executeTool(
      "write_file",
      { path: "a.ts", content: "x" },
      cwd,
    );
    assert.ok(!/hook denied/i.test(event.result));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
