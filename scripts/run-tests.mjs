import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testRoot = path.resolve("src/__tests__");
const testFiles = fs
  .readdirSync(testRoot)
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => path.join(testRoot, name));
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-test-state-"));

try {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--test", ...testFiles],
    {
      stdio: "inherit",
      env: { ...process.env, FIXO_HOME: stateRoot, NODE_ENV: "test" },
    },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(stateRoot, { recursive: true, force: true });
}
