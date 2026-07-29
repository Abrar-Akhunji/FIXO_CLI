import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearTelemetry,
  diagnoseFailures,
  getTelemetryPath,
  readRecentEvents,
  recordTelemetry,
  telemetry,
  type TelemetryEvent,
} from "../agent/telemetry.js";

/** Override the homedir to a temporary directory so we do not touch
 *  the real `~/.fixocli/telemetry.jsonl` during tests. */
function withTempHome<T>(fn: () => T): T {
  const original = process.env.HOME;
  const originalFixoHome = process.env.FIXO_HOME;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-telemetry-"));
  process.env.HOME = tmp;
  process.env.FIXO_HOME = tmp;
  try {
    clearTelemetry(); // ensure clean slate
    return fn();
  } finally {
    if (original === undefined) delete process.env.HOME;
    else process.env.HOME = original;
    if (originalFixoHome === undefined) delete process.env.FIXO_HOME;
    else process.env.FIXO_HOME = originalFixoHome;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

test("recordTelemetry — appends a single NDJSON line", () => {
  withTempHome(() => {
    const event = telemetry.toolCall({
      tool: "read_file",
      status: "completed",
    });
    const ok = recordTelemetry(event);
    assert.equal(ok, true);
    const file = getTelemetryPath();
    assert.ok(fs.existsSync(file), `expected ${file} to exist`);
    const raw = fs.readFileSync(file, "utf-8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]) as TelemetryEvent;
    assert.equal(parsed.type, "tool_call");
    assert.equal(parsed.fields.tool, "read_file");
  });
});

test("recordTelemetry — multiple events are appended in order", () => {
  withTempHome(() => {
    recordTelemetry(
      telemetry.retry({
        fn: "chat",
        attempt: 1,
        delayMs: 100,
        error: "timeout",
      }),
    );
    recordTelemetry(
      telemetry.cooldown({
        providerId: "groq",
        status: 429,
        cooldownMs: 30_000,
        reason: "rate limit",
      }),
    );
    const recent = readRecentEvents();
    assert.equal(recent.length, 2);
    assert.equal(recent[0].type, "retry");
    assert.equal(recent[1].type, "cooldown");
  });
});

test("readRecentEvents — honours the limit", () => {
  withTempHome(() => {
    for (let i = 0; i < 5; i++) {
      recordTelemetry(
        telemetry.retry({ fn: "chat", attempt: i, delayMs: 100, error: "e" }),
      );
    }
    const recent = readRecentEvents(2);
    assert.equal(recent.length, 2);
    // Last-2: attempt 3 and 4.
    assert.equal(recent[0].fields.attempt, 3);
    assert.equal(recent[1].fields.attempt, 4);
  });
});

test("recordTelemetry — returns false when the state directory cannot be written", () => {
  // Simulate an inaccessible state root rather than relying on HOME alone.
  const original = process.env.HOME;
  const originalFixoHome = process.env.FIXO_HOME;
  const inaccessiblePath = "/this/path/definitely/does/not/exist/and/cannot/be/created";
  process.env.HOME = inaccessiblePath;
  process.env.FIXO_HOME = inaccessiblePath;
  try {
    const ok = recordTelemetry(
      telemetry.toolCall({ tool: "x", status: "completed" }),
    );
    assert.equal(ok, false);
  } finally {
    if (original === undefined) delete process.env.HOME;
    else process.env.HOME = original;
    if (originalFixoHome === undefined) delete process.env.FIXO_HOME;
    else process.env.FIXO_HOME = originalFixoHome;
  }
});

test("telemetry constructors — set type, ts, sid, and freeze fields", () => {
  withTempHome(() => {
    const e = telemetry.cooldown({
      providerId: "groq",
      status: 429,
      cooldownMs: 30_000,
      reason: "rate limit",
    });
    assert.equal(e.type, "cooldown");
    assert.match(e.ts, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(e.sid.length, 12);
    assert.throws(() => {
      // The fields object is frozen.
      (e.fields as Record<string, unknown>).providerId = "other";
    });
  });
});

test("diagnoseFailures — empty log returns []", () => {
  withTempHome(() => {
    assert.deepEqual(diagnoseFailures(), []);
  });
});

test("diagnoseFailures — flags a retry storm (>=3 retries)", () => {
  withTempHome(() => {
    for (let i = 0; i < 4; i++) {
      recordTelemetry(
        telemetry.retry({
          fn: "chat",
          attempt: i,
          delayMs: 100,
          error: "timeout",
        }),
      );
    }
    const hints = diagnoseFailures();
    assert.equal(hints.length, 1);
    assert.match(hints[0].summary, /4 retries/);
    assert.equal(hints[0].severity, "warn");
  });
});

test("diagnoseFailures — flags a provider cooldown", () => {
  withTempHome(() => {
    recordTelemetry(
      telemetry.cooldown({
        providerId: "groq",
        status: 429,
        cooldownMs: 30_000,
        reason: "rate limit",
      }),
    );
    const hints = diagnoseFailures();
    assert.ok(hints.some((h) => h.summary.includes("groq")));
  });
});

test("diagnoseFailures — flags stream resume exhaustion as error severity", () => {
  withTempHome(() => {
    recordTelemetry(
      telemetry.streamResume({
        resumeAttempt: 3,
        partialTokens: 0,
        ok: false,
        reason: "exhausted",
      }),
    );
    const hints = diagnoseFailures();
    const exhausted = hints.find((h) => h.severity === "error");
    assert.ok(
      exhausted,
      `expected an error-severity hint, got ${JSON.stringify(hints)}`,
    );
  });
});

test("diagnoseFailures — flags compaction as info", () => {
  withTempHome(() => {
    recordTelemetry(
      telemetry.contextBudget({
        tokensBefore: 100_000,
        tokensAfter: 80_000,
        actions: ["drop-oldest-turns", "mark-for-compaction"],
        markedForCompaction: true,
      }),
    );
    const hints = diagnoseFailures();
    assert.ok(
      hints.some((h) => h.severity === "info" && h.summary.includes("Context")),
    );
  });
});

test("diagnoseFailures — clusters >=3 failures of the same tool", () => {
  withTempHome(() => {
    for (let i = 0; i < 3; i++) {
      recordTelemetry(
        telemetry.toolCall({
          tool: "shell",
          status: "failed",
          error: "EACCES",
        }),
      );
    }
    const hints = diagnoseFailures();
    const toolHint = hints.find((h) => h.summary.includes("shell"));
    assert.ok(
      toolHint,
      `expected a tool-cluster hint, got ${JSON.stringify(hints)}`,
    );
  });
});

test("diagnoseFailures — ignores events outside the window", () => {
  withTempHome(() => {
    // 2 retries is below the threshold anyway, but we want to verify
    // the window filter works for the rare case where the threshold
    // is hit only by old events.
    for (let i = 0; i < 5; i++) {
      const event = telemetry.retry({
        fn: "chat",
        attempt: i,
        delayMs: 100,
        error: "e",
      });
      // Backdate by 2 hours.
      const backdated: TelemetryEvent = {
        ...event,
        ts: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
      };
      recordTelemetry(backdated);
    }
    // 1h window should filter all of them out.
    assert.deepEqual(diagnoseFailures(60 * 60_000), []);
    // 3h window should still surface them.
    const hints = diagnoseFailures(3 * 60 * 60_000);
    assert.ok(hints.length > 0);
  });
});

test("clearTelemetry — removes the file", () => {
  withTempHome(() => {
    recordTelemetry(telemetry.toolCall({ tool: "x", status: "completed" }));
    assert.ok(fs.existsSync(getTelemetryPath()));
    clearTelemetry();
    assert.equal(fs.existsSync(getTelemetryPath()), false);
  });
});

test("recordTelemetry — rotates when file exceeds 1 MiB", () => {
  withTempHome(() => {
    // Write a single huge event whose JSON encoding is > 1 MiB.
    const huge = "x".repeat(2_000_000);
    recordTelemetry(telemetry.toolCall({ tool: huge, status: "completed" }));
    recordTelemetry(
      telemetry.toolCall({ tool: "after-rotate", status: "completed" }),
    );
    const backup = getTelemetryPath() + ".1";
    assert.ok(fs.existsSync(backup), "expected a .1 backup after rotation");
    const recent = readRecentEvents();
    assert.ok(recent.some((e) => e.fields.tool === "after-rotate"));
  });
});
