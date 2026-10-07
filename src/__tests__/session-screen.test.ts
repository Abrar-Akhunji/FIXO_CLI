import test from "node:test";
import assert from "node:assert/strict";
import { fitCell, renderSessionFrame, SessionScreen } from "../ui/session-screen.js";
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
