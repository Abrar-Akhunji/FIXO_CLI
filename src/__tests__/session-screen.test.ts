import test from "node:test";
import assert from "node:assert/strict";
import {
  composerViewport,
  fitCell,
  renderSessionFrame,
  scrollbarGeometry,
  SessionScreen,
  wrapTranscriptLine,
} from "../ui/session-screen.js";
import { verifyFreeLLMLogin } from "../agent/freellm-login.js";

test("session frame keeps one title, one rule, and one activity row", () => {
  const frame = renderSessionFrame({
    mode: "BUILD",
    model: "auto",
    activity: "API 502, retry 2/5 in 3.0s",
    cols: 40,
  });
  assert.equal(frame.title.includes("BUILD"), true);
  assert.equal(frame.title.includes("auto"), true);
  assert.equal(frame.rule, "─".repeat(40));
  assert.equal(frame.activity, "API 502, retry 2/5 in 3.0s");
  assert.equal(fitCell("x".repeat(50), 10).length, 10);
});

test("session screen enters the alternate buffer and restores it", () => {
  const chunks: string[] = [];
  const screen = new SessionScreen(
    { mode: "BUILD", model: "auto" },
    {
      write(chunk) {
        chunks.push(chunk);
      },
      rows: 24,
      cols: 80,
    },
  );
  try {
    screen.open();
    screen.setActivity("Reading src/index.ts");
    screen.suspend();
    screen.resume();
  } finally {
    screen.close();
  }
  const joined = chunks.join("");
  assert.equal(joined.includes("\x1b[?1049h"), true);
  assert.equal(joined.includes("\x1b[?1049l"), true);
  assert.equal(joined.includes("Reading src/index.ts"), true);
  assert.equal(joined.includes("BUILD"), true);
});

test("long transcript lines wrap and long composer text follows the cursor", () => {
  assert.deepEqual(wrapTranscriptLine("abcdefghij", 4), ["abcd", "efgh", "ij"]);
  const view = composerViewport("abcdefghijklmnopqrst", 20, 10);
  assert.equal(view.text.length, 10);
  assert.ok(view.text.startsWith("…"));
  assert.equal(view.cursor, 10);
});

test("screen retains transcript while changing its anchored composer", async () => {
  const chunks: string[] = [];
  const screen = new SessionScreen(
    { mode: "BUILD", model: "auto" },
    { write: (chunk) => chunks.push(chunk), rows: 12, cols: 30 },
  );
  try {
    screen.open();
    screen.appendMessage("first message\nsecond message");
    screen.setComposer("follow-up", 9);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(screen.transcriptLength(), 3);
    const frame = chunks.join("");
    assert.ok(frame.includes("first message"));
    assert.ok(frame.includes("second message"));
    assert.ok(frame.includes("› follow-up"));
  } finally {
    screen.close();
  }
});

test("scrollbar maps bottom-relative history to a conventional rail", () => {
  assert.deepEqual(scrollbarGeometry(100, 10, 0), {
    thumbStart: 9,
    thumbSize: 1,
    maxOffset: 90,
  });
  assert.equal(scrollbarGeometry(100, 10, 90).thumbStart, 0);
  assert.deepEqual(scrollbarGeometry(4, 10, 0), {
    thumbStart: 0,
    thumbSize: 10,
    maxOffset: 0,
  });
});

test("mouse wheel accelerates and the right rail jumps through history", () => {
  const screen = new SessionScreen(
    { mode: "BUILD", model: "auto" },
    { write: () => {}, rows: 24, cols: 80 },
  );
  try {
    screen.open();
    screen.appendMessage(Array.from({ length: 50 }, (_, index) => `line ${index}`).join("\n"));
    assert.equal(screen.handleMouse(64, 40, 10, "M"), true);
    assert.equal((screen as any).scrollOffset, 4);
    assert.equal(screen.handleMouse(0, 79, 3, "M"), true);
    assert.equal((screen as any).scrollOffset, 38);
    assert.equal(screen.handleMouse(0, 79, 15, "M"), true);
    assert.equal((screen as any).scrollOffset, 0);
  } finally {
    screen.close();
  }
});

test("session screen renders telemetry and restored role-separated history", async () => {
  const chunks: string[] = [];
  const screen = new SessionScreen(
    {
      mode: "BUILD",
      model: "gpt-test",
      provider: "OpenAI",
      session: "provider-picker",
      contextUsed: 1200,
      contextLimit: 8000,
      sessionTokens: 1500,
      turns: 2,
      toolCalls: 3,
    },
    { write: (chunk) => chunks.push(chunk), rows: 24, cols: 120 },
  );
  try {
    screen.open();
    screen.setConversationHistory([
      { role: "user", content: "Fix the picker" },
      { role: "assistant", content: "I will." },
    ]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const output = chunks.join("");
    assert.match(output, /OpenAI \/ gpt-test/);
    assert.match(output, /session provider-picker/);
    assert.match(output, /ctx 1,200 \/ 8,000 \(15%\)/);
    assert.match(output, /1,500 tokens/);
    assert.match(output, /You/);
    assert.match(output, /FIXO/);
  } finally {
    screen.close();
  }
});

test("a short terminal keeps the composer on-screen", async () => {
  const chunks: string[] = [];
  const screen = new SessionScreen(
    { mode: "PLAN", model: "auto" },
    { write: (chunk) => chunks.push(chunk), rows: 5, cols: 24 },
  );
  try {
    screen.open();
    screen.setComposer("tiny screen");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const output = chunks.join("");
    assert.ok(output.includes("\x1b[4;1H"));
    assert.ok(output.includes("› tiny screen"));
    assert.equal(/\x1b\[[6-9];1H/.test(output), false);
  } finally {
    screen.close();
  }
});

test("verifyFreeLLMLogin accepts a catalog and rejects a 401", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: "alpha" }, { id: 4 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const ok = await verifyFreeLLMLogin(
      "https://example.test/v1",
      "freellmapi-test",
    );
    assert.deepEqual(ok, { ok: true, modelCount: 1 });

    globalThis.fetch = (async () =>
      new Response("no", { status: 401 })) as typeof fetch;
    const denied = await verifyFreeLLMLogin(
      "https://example.test/v1",
      "freellmapi-test",
    );
    assert.deepEqual(denied, { ok: false, reason: "unauthorized" });
  } finally {
    globalThis.fetch = original;
  }
});
