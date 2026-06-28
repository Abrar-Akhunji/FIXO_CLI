import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LspPreSaveGate,
  LspPreSaveBlockedError,
  normaliseDiagnostic,
  normaliseSeverity,
  makeLspProvider,
  type LspDiagnostic,
  type LspDiagnosticsProvider,
} from "../lsp/lsp-pre-save.js";
import {
  AtomicStagingManager,
  PreCommitHookRejectedError,
} from "../runtime/staging.js";

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

function withTempCwd<T>(fn: (cwd: string) => Promise<T> | T): Promise<T> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-lsp-presave-"));
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

const mkDiag = (over: Partial<LspDiagnostic> = {}): LspDiagnostic => ({
  severity: "error",
  message: "unknown identifier",
  line: 0,
  column: 0,
  source: "ts",
  code: 2304,
  ...over,
});

/* ------------------------------------------------------------------ */
/* normalise helpers                                                   */
/* ------------------------------------------------------------------ */

test("normaliseSeverity — maps LSP int severities", () => {
  assert.equal(normaliseSeverity(1), "error");
  assert.equal(normaliseSeverity(2), "warning");
  assert.equal(normaliseSeverity(3), "info");
  assert.equal(normaliseSeverity(4), "hint");
  assert.equal(normaliseSeverity(undefined), "info");
});

test("normaliseDiagnostic — extracts message, line, source, code", () => {
  const raw = {
    severity: 1,
    message: 'Cannot find name "x"',
    range: { start: { line: 12, character: 4 } },
    source: "typescript",
    code: 2304,
  };
  const d = normaliseDiagnostic(raw);
  assert.equal(d.severity, "error");
  assert.equal(d.message, 'Cannot find name "x"');
  assert.equal(d.line, 12);
  assert.equal(d.column, 4);
  assert.equal(d.source, "typescript");
  assert.equal(d.code, 2304);
});

test("normaliseDiagnostic — handles null/malformed input safely", () => {
  const d = normaliseDiagnostic(null);
  assert.equal(d.severity, "info");
  assert.equal(d.message, "null");
  assert.equal(d.line, 0);
});

/* ------------------------------------------------------------------ */
/* mode='off' is a no-op                                                */
/* ------------------------------------------------------------------ */

test("check — off mode returns ok without calling the provider", async () => {
  let called = 0;
  const provider: LspDiagnosticsProvider = async () => {
    called += 1;
    return [mkDiag()];
  };
  const gate = new LspPreSaveGate({ mode: "off", provider });
  const result = await gate.check({
    id: "x",
    targetPath: "/tmp/x",
    pendingPath: "/tmp/.fixo/staging/r/x.pending",
    metaPath: "/tmp/.fixo/staging/r/x.meta.json",
    createdAt: Date.now(),
    mode: 0o644,
  });
  assert.equal(result.state, "ok");
  assert.equal(called, 0, "provider should not be called in off mode");
});

/* ------------------------------------------------------------------ */
/* warn mode: never throws, never blocks                                */
/* ------------------------------------------------------------------ */

test("check — warn mode reports diagnostics but enforce() does not throw", async () => {
  const provider: LspDiagnosticsProvider = async () => [
    mkDiag({ severity: "error" }),
  ];
  const gate = new LspPreSaveGate({ mode: "warn", provider });
  const entry = {
    id: "x",
    targetPath: "/tmp/x",
    pendingPath: "/tmp/x",
    metaPath: "/tmp/x.meta",
    createdAt: 0,
    mode: 0o644,
  };
  const result = await gate.check(entry);
  assert.equal(result.state, "diagnostics");
  if (result.state === "diagnostics") {
    assert.equal(result.errorCount, 1);
  }
  // enforce() in warn mode never throws.
  gate.enforce(result, entry);
});

/* ------------------------------------------------------------------ */
/* block mode: throws on error severity                                 */
/* ------------------------------------------------------------------ */

test("check + enforce — block mode throws LspPreSaveBlockedError on error", async () => {
  const provider: LspDiagnosticsProvider = async () => [
    mkDiag({ severity: "warning", message: "minor" }),
    mkDiag({ severity: "error", message: "boom", line: 5, column: 3 }),
  ];
  const gate = new LspPreSaveGate({ mode: "block", provider });
  const entry = {
    id: "x",
    targetPath: "/tmp/x",
    pendingPath: "/tmp/x",
    metaPath: "/tmp/x.meta",
    createdAt: 0,
    mode: 0o644,
  };
  const result = await gate.check(entry);
  assert.equal(result.state, "diagnostics");
  if (result.state === "diagnostics") {
    assert.equal(result.errorCount, 1);
  }
  assert.throws(
    () => gate.enforce(result, entry),
    (err: unknown) => {
      return (
        err instanceof LspPreSaveBlockedError &&
        err.targetPath === "/tmp/x" &&
        err.diagnostics.length === 2
      );
    },
  );
});

test("check + enforce — block mode does not throw when only warnings exist", async () => {
  const provider: LspDiagnosticsProvider = async () => [
    mkDiag({ severity: "warning" }),
  ];
  const gate = new LspPreSaveGate({ mode: "block", provider });
  const entry = {
    id: "x",
    targetPath: "/tmp/x",
    pendingPath: "/tmp/x",
    metaPath: "/tmp/x.meta",
    createdAt: 0,
    mode: 0o644,
  };
  const result = await gate.check(entry);
  assert.equal(result.state, "diagnostics");
  // No throw — block mode only fires on `error` severity.
  gate.enforce(result, entry);
});

/* ------------------------------------------------------------------ */
/* provider errors / timeouts                                          */
/* ------------------------------------------------------------------ */

test("check — provider timeout is treated as a pass-through", async () => {
  const slow: LspDiagnosticsProvider = () =>
    new Promise(() => {
      // never resolves
    });
  const gate = new LspPreSaveGate({
    mode: "block",
    provider: slow,
    timeoutMs: 30,
  });
  const result = await gate.check({
    id: "x",
    targetPath: "/tmp/x",
    pendingPath: "/tmp/x",
    metaPath: "/tmp/x.meta",
    createdAt: 0,
    mode: 0o644,
  });
  assert.equal(result.state, "no-language-server");
});

test("check — provider rejection is treated as a pass-through", async () => {
  const broken: LspDiagnosticsProvider = async () => {
    throw new Error("LSP server crashed");
  };
  const gate = new LspPreSaveGate({ mode: "block", provider: broken });
  const result = await gate.check({
    id: "x",
    targetPath: "/tmp/x",
    pendingPath: "/tmp/x",
    metaPath: "/tmp/x.meta",
    createdAt: 0,
    mode: 0o644,
  });
  assert.equal(result.state, "no-language-server");
});

/* ------------------------------------------------------------------ */
/* end-to-end: wire the gate into AtomicStagingManager                 */
/* ------------------------------------------------------------------ */

test("end-to-end — block-mode gate rejects commit and preserves the target", async () => {
  await withTempCwd(async (cwd) => {
    const target = path.join(cwd, "guarded.ts");
    fs.writeFileSync(target, "original", "utf-8");
    const provider: LspDiagnosticsProvider = async () => [
      mkDiag({ severity: "error", message: "compile failed" }),
    ];
    const gate = new LspPreSaveGate({ mode: "block", provider });
    const mgr = new AtomicStagingManager(cwd, "r1", {
      preCommitHook: async (entry) => {
        const result = await gate.check(entry);
        gate.enforce(result, entry);
      },
    });
    const entry = mgr.stage("guarded.ts", "broken content");
    await assert.rejects(
      () => mgr.commit(entry.id),
      (err: unknown) => {
        if (!(err instanceof PreCommitHookRejectedError)) return false;
        return err.cause instanceof LspPreSaveBlockedError;
      },
    );
    // Original file preserved.
    assert.equal(fs.readFileSync(target, "utf-8"), "original");
  });
});

test("end-to-end — warn-mode gate lets the commit proceed", async () => {
  await withTempCwd(async (cwd) => {
    const target = path.join(cwd, "linted.ts");
    const provider: LspDiagnosticsProvider = async () => [
      mkDiag({ severity: "warning", message: "unused var" }),
    ];
    const gate = new LspPreSaveGate({ mode: "warn", provider });
    const mgr = new AtomicStagingManager(cwd, "r1", {
      preCommitHook: async (entry) => {
        const result = await gate.check(entry);
        gate.enforce(result, entry);
      },
    });
    const entry = mgr.stage("linted.ts", "export const x = 1;");
    const res = await mgr.commit(entry.id);
    assert.equal(res.committed, true);
    assert.equal(fs.readFileSync(target, "utf-8"), "export const x = 1;");
  });
});

/* ------------------------------------------------------------------ */
/* makeLspProvider adapter                                              */
/* ------------------------------------------------------------------ */

test("makeLspProvider — returns empty when client is null (no LSP installed)", async () => {
  const lspManager = { getClientAndSync: async () => null };
  const provider = makeLspProvider(lspManager);
  const result = await provider("/tmp/foo.ts");
  assert.deepEqual(result, []);
});

test("makeLspProvider — normalises raw diagnostics from the client", async () => {
  const lspManager = {
    getClientAndSync: async () => ({
      getDiagnostics: () => [
        {
          severity: 1,
          message: "m",
          range: { start: { line: 1, character: 2 } },
          source: "ts",
          code: 100,
        },
      ],
    }),
  };
  const provider = makeLspProvider(lspManager);
  const result = await provider("/tmp/foo.ts");
  assert.equal(result.length, 1);
  assert.equal(result[0]?.severity, "error");
  assert.equal(result[0]?.line, 1);
  assert.equal(result[0]?.code, 100);
});

/* ------------------------------------------------------------------ */
/* observer (onResult) fires                                           */
/* ------------------------------------------------------------------ */

test("onResult — fires once with the verdict and never throws out of the gate", async () => {
  let calls = 0;
  let lastDiagCount = -1;
  const provider: LspDiagnosticsProvider = async () => [mkDiag()];
  const gate = new LspPreSaveGate({
    mode: "warn",
    provider,
    onResult: (r) => {
      calls += 1;
      if (r.state === "diagnostics") lastDiagCount = r.diagnostics.length;
      throw new Error("observer should not propagate");
    },
  });
  const result = await gate.check({
    id: "x",
    targetPath: "/tmp/x",
    pendingPath: "/tmp/x",
    metaPath: "/tmp/x.meta",
    createdAt: 0,
    mode: 0o644,
  });
  assert.equal(calls, 1);
  assert.equal(lastDiagCount, 1);
  assert.equal(result.state, "diagnostics");
});
