import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SANDBOX_PROFILES,
  resolveSandboxProfile,
} from "../runtime/os-sandbox.js";

test("SANDBOX_PROFILES contains strict, devbox, and read-only specifications", () => {
  assert.ok(SANDBOX_PROFILES.devbox);
  assert.ok(SANDBOX_PROFILES.strict);
  assert.ok(SANDBOX_PROFILES["read-only"]);

  assert.equal(SANDBOX_PROFILES.devbox.allowNetwork, true);
  assert.equal(SANDBOX_PROFILES.devbox.readOnlyWorkspace, false);

  assert.equal(SANDBOX_PROFILES.strict.allowNetwork, false);
  assert.equal(SANDBOX_PROFILES.strict.readOnlyWorkspace, true);

  assert.equal(SANDBOX_PROFILES["read-only"].allowNetwork, true);
  assert.equal(SANDBOX_PROFILES["read-only"].readOnlyWorkspace, true);
});

test("resolveSandboxProfile configures devbox profile with write access and network", () => {
  const ws = "/fake/workspace";
  const opts = resolveSandboxProfile(ws, "devbox");

  assert.equal(opts.allowNetwork, true);
  assert.equal(opts.profile, "devbox");
  assert.equal(opts.cwd, ws);
  assert.ok(opts.allowedWritePaths.includes(ws));
});

test("resolveSandboxProfile configures strict profile with read-only root and no network", () => {
  const ws = "/fake/workspace";
  const opts = resolveSandboxProfile(ws, "strict");

  assert.equal(opts.allowNetwork, false);
  assert.equal(opts.profile, "strict");
  assert.equal(opts.cwd, ws);
  // Must NOT include workspace root in writable paths
  assert.equal(opts.allowedWritePaths.includes(ws), false);
});

test("resolveSandboxProfile configures read-only profile with read-only root and network enabled", () => {
  const ws = "/fake/workspace";
  const opts = resolveSandboxProfile(ws, "read-only");

  assert.equal(opts.allowNetwork, true);
  assert.equal(opts.profile, "read-only");
  assert.equal(opts.cwd, ws);
  // Must NOT include workspace root in writable paths
  assert.equal(opts.allowedWritePaths.includes(ws), false);
});

test("resolveSandboxProfile respects overrides", () => {
  const ws = "/fake/workspace";
  const opts = resolveSandboxProfile(ws, "strict", {
    cwd: "/fake/subdir",
    timeout: 120_000,
    maxBuffer: 2 * 1024 * 1024,
    allowedWritePaths: ["/custom/cache"],
  });

  assert.equal(opts.cwd, "/fake/subdir");
  assert.equal(opts.timeout, 120_000);
  assert.equal(opts.maxBuffer, 2 * 1024 * 1024);
  assert.ok(opts.allowedWritePaths.includes("/custom/cache"));
  assert.equal(opts.allowedWritePaths.includes(ws), false);
});
