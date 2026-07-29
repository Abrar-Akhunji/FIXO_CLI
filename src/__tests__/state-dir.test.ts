import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getStateDir, getWorkspaceStateDir } from "../config.js";

test("FIXO_HOME takes precedence and workspace state is isolated by path", () => {
  const original = process.env.FIXO_HOME;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-state-root-"));
  try {
    process.env.FIXO_HOME = root;
    assert.equal(getStateDir(), root);
    assert.match(getWorkspaceStateDir("/tmp/project-a"), /workspaces[\\/][a-f0-9]{32}$/);
    assert.notEqual(
      getWorkspaceStateDir("/tmp/project-a"),
      getWorkspaceStateDir("/tmp/project-b"),
    );
  } finally {
    if (original === undefined) delete process.env.FIXO_HOME;
    else process.env.FIXO_HOME = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
