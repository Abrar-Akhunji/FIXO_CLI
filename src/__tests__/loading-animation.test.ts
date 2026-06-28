import { test } from "node:test";
import * as assert from "node:assert";
import { LoadingAnimation } from "../ui/loading-animation.js";

test("LoadingAnimation basic start/stop", () => {
  const animation = new LoadingAnimation();
  assert.ok(animation);

  // start should not throw
  assert.doesNotThrow(() => animation.start());

  // stop should not throw
  assert.doesNotThrow(() => animation.stop());
});

test("LoadingAnimation setPhase updates phase", () => {
  const animation = new LoadingAnimation();

  // mock stdout write to verify
  let written = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk: string | Uint8Array) => {
    written += chunk.toString();
    return true;
  };

  try {
    animation.setPhase({
      id: "reading",
      label: "Test Label",
      detail: "test.ts",
      icon: "✦",
    });

    // In non-tty this logs immediately
    if (!process.stdout.isTTY) {
      assert.ok(written.includes("Test Label"));
      assert.ok(written.includes("test.ts"));
      assert.ok(written.includes("✦"));
    }
  } finally {
    process.stdout.write = originalWrite;
  }
});

test("LoadingAnimation setTurn updates turn count", () => {
  const animation = new LoadingAnimation();
  assert.doesNotThrow(() => animation.setTurn(2));
});

test("LoadingAnimation markCancelled stops animation and logs cancel message", () => {
  const animation = new LoadingAnimation();

  let written = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk: string | Uint8Array) => {
    written += chunk.toString();
    return true;
  };

  try {
    animation.start();
    animation.markCancelled();
    assert.ok(written.includes("Task cancelled"));
  } finally {
    process.stdout.write = originalWrite;
  }
});
