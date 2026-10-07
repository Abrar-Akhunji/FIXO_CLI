import assert from "node:assert/strict";
import test from "node:test";
import {
  isSensitiveCredentialPath,
  isToolResultFailure,
} from "../agent/tool-executor.js";
import { exitStatus } from "../test-runner.js";

test("isToolResultFailure recognizes command, patch, and subagent failures", () => {
  assert.equal(isToolResultFailure("Error: File not found"), true);
  assert.equal(
    isToolResultFailure("Command execution failed: spawn ENOENT"),
    true,
  );
  assert.equal(isToolResultFailure("Command exited with code 2"), true);
  assert.equal(
    isToolResultFailure("oops\n\n(command failed with exit code 1)"),
    true,
  );
  assert.equal(
    isToolResultFailure("oops\n\n(command terminated by signal SIGTERM)"),
    true,
  );
  assert.equal(isToolResultFailure("Patch failed:\nconflict"), true);
  assert.equal(isToolResultFailure("Subagent failed: boom"), true);
  assert.equal(isToolResultFailure("todo_write: failed to persist: disk"), true);
  assert.equal(isToolResultFailure("File updated: src/a.ts"), false);
  assert.equal(isToolResultFailure("(command completed with code 0)"), false);
});

test("exitStatus treats timeout and signal as failure", () => {
  assert.equal(exitStatus({ status: 0 }), 0);
  assert.equal(exitStatus({ status: 2 }), 2);
  assert.equal(
    exitStatus({ status: null, error: new Error("timed out") }),
    1,
  );
  assert.equal(exitStatus({ status: null, signal: "SIGTERM" }), 1);
  assert.equal(exitStatus({ status: null }), 1);
});

test("isSensitiveCredentialPath covers ssh, credentials, and key material", () => {
  assert.equal(isSensitiveCredentialPath("/repo/.env"), true);
  assert.equal(isSensitiveCredentialPath("/repo/.env.local"), true);
  assert.equal(isSensitiveCredentialPath("/repo/.ssh/id_rsa"), true);
  assert.equal(isSensitiveCredentialPath("/repo/secrets/credentials"), true);
  assert.equal(isSensitiveCredentialPath("/repo/authorized_keys"), true);
  assert.equal(isSensitiveCredentialPath("/repo/cert.pem"), true);
  assert.equal(isSensitiveCredentialPath("/repo/private.key"), true);
  assert.equal(isSensitiveCredentialPath("/repo/providers.json"), true);
  assert.equal(isSensitiveCredentialPath("/repo/src/index.ts"), false);
});
