import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AtomicStagingManager,
  StagedWriteNotFoundError,
  StagingPathEscapeError,
  PreCommitHookRejectedError,
} from "../runtime/staging.js";

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

function withTempCwd<T>(fn: (cwd: string) => Promise<T> | T): Promise<T> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-staging-"));
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

/* ------------------------------------------------------------------ */
/* stage / metadata layout                                             */
/* ------------------------------------------------------------------ */

test("stage — writes .pending and .meta.json with 0o600 mode", async () => {
  await withTempCwd((cwd) => {
    const mgr = new AtomicStagingManager(cwd, "r1");
    const entry = mgr.stage("hello.txt", "world");
    assert.ok(fs.existsSync(entry.pendingPath));
    assert.ok(fs.existsSync(entry.metaPath));
    const meta = JSON.parse(fs.readFileSync(entry.metaPath, "utf-8")) as {
      targetPath: string;
      mode: number;
      createdAt: number;
    };
    assert.equal(meta.mode, 0o644);
    // WorkspaceGuard realpath-resolves the target, so compare via
    // the staging manager's recorded targetPath directly.
    assert.equal(meta.targetPath, entry.targetPath);
    assert.equal(path.basename(meta.targetPath), "hello.txt");
    assert.ok(typeof meta.createdAt === "number");
    // On POSIX, stat() reports the mode in the high bits.
    const stat = fs.statSync(entry.pendingPath);
    // 0o600 -> 0o100000 & 0o777 == 0o600 (regular file, rw owner).
    assert.equal(stat.mode & 0o777, 0o600);
  });
});

test("stage — refuses paths that escape the workspace root", async () => {
  await withTempCwd((cwd) => {
    const mgr = new AtomicStagingManager(cwd, "r1");
    assert.throws(
      () => mgr.stage("../escape.txt", "nope"),
      (err: unknown) => err instanceof StagingPathEscapeError,
    );
  });
});

/* ------------------------------------------------------------------ */
/* commit: rename + backup                                             */
/* ------------------------------------------------------------------ */

test("commit — creates a fresh file when the target does not exist", async () => {
  await withTempCwd(async (cwd) => {
    const mgr = new AtomicStagingManager(cwd, "r1");
    const entry = mgr.stage("new.txt", "hello");
    const res = await mgr.commit(entry.id);
    assert.equal(res.committed, true);
    assert.equal(res.backupCreated, false);
    assert.equal(fs.readFileSync(path.join(cwd, "new.txt"), "utf-8"), "hello");
    // Pending and meta are gone.
    assert.equal(fs.existsSync(entry.pendingPath), false);
    assert.equal(fs.existsSync(entry.metaPath), false);
  });
});

test("commit — backs up the original and removes the backup on success", async () => {
  await withTempCwd(async (cwd) => {
    const target = path.join(cwd, "existing.txt");
    fs.writeFileSync(target, "old content", "utf-8");
    const mgr = new AtomicStagingManager(cwd, "r1");
    const entry = mgr.stage("existing.txt", "new content");
    const res = await mgr.commit(entry.id);
    assert.equal(res.committed, true);
    assert.equal(res.backupCreated, true);
    assert.equal(fs.readFileSync(target, "utf-8"), "new content");
    // No .pending.bak remains.
    assert.equal(fs.existsSync(`${target}.pending.bak`), false);
  });
});

test("commit — pre-commit hook rejection preserves the target", async () => {
  await withTempCwd(async (cwd) => {
    const target = path.join(cwd, "guarded.txt");
    fs.writeFileSync(target, "original", "utf-8");
    const mgr = new AtomicStagingManager(cwd, "r1", {
      preCommitHook: () => {
        throw new Error("LSP gate rejected");
      },
    });
    const entry = mgr.stage("guarded.txt", "new content");
    await assert.rejects(
      () => mgr.commit(entry.id),
      (err: unknown) =>
        err instanceof PreCommitHookRejectedError &&
        /LSP gate rejected/.test(String(err)),
    );
    // Target preserved.
    assert.equal(fs.readFileSync(target, "utf-8"), "original");
    // Staged write was discarded.
    assert.throws(
      () => mgr.readEntry(entry.id),
      (err: unknown) => err instanceof StagedWriteNotFoundError,
    );
  });
});

test("commit — missing staged write throws StagedWriteNotFoundError", async () => {
  await withTempCwd(async (cwd) => {
    const mgr = new AtomicStagingManager(cwd, "r1");
    await assert.rejects(
      () =>
        mgr.commit(
          "nonexistent-id-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        ),
      (err: unknown) => err instanceof StagedWriteNotFoundError,
    );
  });
});

/* ------------------------------------------------------------------ */
/* discard / list                                                       */
/* ------------------------------------------------------------------ */

test("discard — removes pending and meta without touching the target", async () => {
  await withTempCwd((cwd) => {
    const target = path.join(cwd, "keep.txt");
    fs.writeFileSync(target, "untouched", "utf-8");
    const mgr = new AtomicStagingManager(cwd, "r1");
    const entry = mgr.stage("keep.txt", "changed");
    mgr.discard(entry.id);
    assert.equal(fs.existsSync(entry.pendingPath), false);
    assert.equal(fs.existsSync(entry.metaPath), false);
    assert.equal(fs.readFileSync(target, "utf-8"), "untouched");
  });
});

test("list — returns all staged writes for this run", async () => {
  await withTempCwd((cwd) => {
    const mgr = new AtomicStagingManager(cwd, "r1");
    mgr.stage("a.txt", "A");
    mgr.stage("b.txt", "B");
    mgr.stage("c.txt", "C");
    const list = mgr.list();
    assert.equal(list.length, 3);
    const targets = list.map((e) => path.basename(e.targetPath)).sort();
    assert.deepEqual(targets, ["a.txt", "b.txt", "c.txt"]);
  });
});

/* ------------------------------------------------------------------ */
/* gc (per-run + global)                                                */
/* ------------------------------------------------------------------ */

test("gc — removes entries older than ttlMs", async () => {
  await withTempCwd((cwd) => {
    const mgr = new AtomicStagingManager(cwd, "r1", { ttlMs: 1000 });
    const entry = mgr.stage("old.txt", "stale");
    // Backdate the meta by 5 seconds.
    const metaPath = entry.metaPath;
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as {
      createdAt: number;
    };
    meta.createdAt = Date.now() - 5000;
    fs.writeFileSync(metaPath, JSON.stringify(meta), "utf-8");
    const removed = mgr.gc();
    assert.equal(removed, 1);
    assert.equal(fs.existsSync(entry.pendingPath), false);
  });
});

test("gc — keeps entries within ttlMs", async () => {
  await withTempCwd((cwd) => {
    const mgr = new AtomicStagingManager(cwd, "r1", { ttlMs: 60_000 });
    mgr.stage("fresh.txt", "recent");
    const removed = mgr.gc();
    assert.equal(removed, 0);
    assert.equal(mgr.list().length, 1);
  });
});

test("garbageCollectAll — sweeps every run-id directory", async () => {
  await withTempCwd((cwd) => {
    const m1 = new AtomicStagingManager(cwd, "run-A", { ttlMs: 1000 });
    const m2 = new AtomicStagingManager(cwd, "run-B", { ttlMs: 1000 });
    const e1 = m1.stage("one.txt", "A");
    const e2 = m2.stage("two.txt", "B");
    // Backdate both.
    for (const metaPath of [e1.metaPath, e2.metaPath]) {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as {
        createdAt: number;
      };
      meta.createdAt = Date.now() - 5000;
      fs.writeFileSync(metaPath, JSON.stringify(meta), "utf-8");
    }
    const removed = AtomicStagingManager.garbageCollectAll(cwd, 1000);
    assert.equal(removed, 2);
    assert.equal(fs.existsSync(e1.pendingPath), false);
    assert.equal(fs.existsSync(e2.pendingPath), false);
  });
});

test("gc — runs in under 50ms on 200 entries", async () => {
  await withTempCwd((cwd) => {
    const mgr = new AtomicStagingManager(cwd, "perf", { ttlMs: 60_000 });
    for (let i = 0; i < 200; i++) {
      mgr.stage(`file-${i}.txt`, `content-${i}`);
    }
    const t0 = Date.now();
    mgr.gc();
    const dt = Date.now() - t0;
    assert.ok(dt < 50, `gc took ${dt}ms, expected < 50ms`);
  });
});

/* ------------------------------------------------------------------ */
/* safety and ergonomics                                                */
/* ------------------------------------------------------------------ */

test("runId — invalid characters are rejected", async () => {
  await withTempCwd((cwd) => {
    assert.throws(() => new AtomicStagingManager(cwd, "../escape"));
    assert.throws(() => new AtomicStagingManager(cwd, ""));
    assert.throws(() => new AtomicStagingManager(cwd, "has space"));
  });
});

test("stage — staged file is removed on commit and not re-listed", async () => {
  await withTempCwd(async (cwd) => {
    const mgr = new AtomicStagingManager(cwd, "r1");
    const entry = mgr.stage("committed.txt", "x");
    await mgr.commit(entry.id);
    const list = mgr.list();
    assert.equal(list.length, 0);
  });
});

test("read — returns the staged content verbatim", async () => {
  await withTempCwd((cwd) => {
    const mgr = new AtomicStagingManager(cwd, "r1");
    const entry = mgr.stage("payload.txt", "round-trip");
    assert.equal(mgr.read(entry.id), "round-trip");
  });
});
