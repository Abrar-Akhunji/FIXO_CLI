import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getBackgroundJobRegistry } from "../runtime/background-jobs.js";
import { detachCurrentForegroundCommand, executeTool } from "../agent/tool-executor.js";

test("BackgroundJobRegistry is an EventEmitter and emits job-finished on exit", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-bg-test-"));
  const reg = getBackgroundJobRegistry(tmpDir);
  try {
    const finishedPromise = new Promise<any>((resolve) => {
      reg.once("job-finished", (job) => {
        resolve(job);
      });
    });

    const spawnRes = await reg.register({
      cmd: process.execPath,
      args: ["-e", "process.stdout.write('bg ok'); process.exit(0);"],
      cwd: tmpDir,
    });

    assert.equal(spawnRes.ok, true);
    const finishedJob = await finishedPromise;
    assert.equal(finishedJob.id, spawnRes.jobId);
    assert.equal(finishedJob.status, "exited");
    assert.equal(finishedJob.exitCode, 0);
  } finally {
    reg.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("waitForJobs waits until specified job finishes or returns current state", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-bg-test-"));
  const reg = getBackgroundJobRegistry(tmpDir);
  try {
    const spawnRes = await reg.register({
      cmd: process.execPath,
      args: ["-e", "process.stdout.write('waiting done'); process.exit(0);"],
      cwd: tmpDir,
    });

    assert.equal(spawnRes.ok, true);
    const snapshots = await reg.waitForJobs([spawnRes.jobId!], 5000);
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].status, "exited");
    assert.ok(snapshots[0].stdout.includes("waiting done"));
  } finally {
    reg.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("detachCurrentForegroundCommand returns ok: false when no foreground command is active", () => {
  const result = detachCurrentForegroundCommand();
  assert.equal(result.ok, false);
  assert.ok(result.message?.includes("No active foreground command"));
});

test("executes get_command_output tool cleanly", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-bg-test-"));
  const reg = getBackgroundJobRegistry(tmpDir);
  try {
    const spawnRes = await reg.register({
      cmd: process.execPath,
      args: ["-e", "process.stdout.write('tool output test'); process.exit(0);"],
      cwd: tmpDir,
    });
    assert.equal(spawnRes.ok, true);

    const out = await executeTool(
      "get_command_output",
      { task_ids: [spawnRes.jobId] as any, timeout_ms: "5000" },
      tmpDir,
    );
    assert.ok(out.result.includes("tool output test"));
    assert.ok(out.result.includes("exit code 0"));
  } finally {
    reg.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
