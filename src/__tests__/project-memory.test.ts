import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  getDb,
  calculateTfidfSimilarity,
  appendMemory,
  readMemory,
  forgetMemory,
  appendSessionSummary,
  readSessionHistory,
  retrieveRelevantFacts,
} from "../project-memory.js";
import { getWorkspaceStateDir } from "../config.js";
import { initializePlugins, loadedPlugins } from "../agent/tool-executor.js";

const originalFixoHome = process.env.FIXO_HOME;
const testFixoHome = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-memory-state-"));
process.env.FIXO_HOME = testFixoHome;
test.after(() => {
  if (originalFixoHome === undefined) delete process.env.FIXO_HOME;
  else process.env.FIXO_HOME = originalFixoHome;
  fs.rmSync(testFixoHome, { recursive: true, force: true });
});

test("SQLite Migration from legacy memory.md", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-mem-"));
  const fixoDir = path.join(getWorkspaceStateDir(tempDir), "memory");
  fs.mkdirSync(fixoDir, { recursive: true });

  // Write legacy memory.md
  fs.writeFileSync(
    path.join(fixoDir, "memory.md"),
    "# FixO Project Memory\n\n- Fact 1: Use Node v24.\n- Fact 2: SQLite database is local.\n",
    "utf-8",
  );

  // Initialize db, which triggers migration
  const db = getDb(tempDir);

  // Assert legacy memory file is renamed
  assert.ok(fs.existsSync(path.join(fixoDir, "memory.md.migrated")));
  assert.ok(!fs.existsSync(path.join(fixoDir, "memory.md")));

  // Read memory using readMemory
  const memoryStr = readMemory(tempDir);
  assert.ok(memoryStr.includes("Fact 1: Use Node v24."));
  assert.ok(memoryStr.includes("Fact 2: SQLite database is local."));

  // Clean up
  forgetMemory(tempDir);
  assert.equal(readMemory(tempDir).trim(), "");
});

test("TF-IDF Cosine Similarity ranking", () => {
  const query = "node sqlite database";
  const docs = [
    "This is a project about node and sqlite database storage.",
    "Vanilla CSS is used for styling the components.",
    "Nothing to do with databases or nodes.",
  ];

  const sims = calculateTfidfSimilarity(query, docs);
  assert.equal(sims.length, 3);
  // First doc should have the highest similarity
  assert.ok(sims[0] > sims[1]);
  assert.ok(sims[0] > sims[2]);
});

test("SQLite facts retrieval and TF-IDF fallback", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-mem-retrieve-"));

  appendMemory(tempDir, "Fact A: The database runs on node:sqlite.");
  appendMemory(tempDir, "Fact B: TailwindCSS is not allowed.");

  const relevant = await retrieveRelevantFacts(
    tempDir,
    "node database sqlite",
    undefined,
    1,
  );
  assert.equal(relevant.length, 1);
  assert.equal(relevant[0], "Fact A: The database runs on node:sqlite.");
});

test("Session history append and read", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-mem-session-"));
  appendSessionSummary(tempDir, "Session 1 completed successfully.");
  appendSessionSummary(tempDir, "Session 2 failed.");

  const history = readSessionHistory(tempDir);
  assert.equal(history.length, 2);
  assert.equal(history[0], "Session 2 failed.");
  assert.equal(history[1], "Session 1 completed successfully.");
});

test("Plugin loader allowlist validation", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-plugin-"));
  const pluginFile = path.join(tempDir, "my-plugin.js");

  // Write a simple valid ESModule plugin
  fs.writeFileSync(
    pluginFile,
    `
    export const tools = [
      {
        type: 'function',
        function: {
          name: 'custom_plugin_tool',
          description: 'A custom tool',
          parameters: { type: 'object', properties: {} }
        }
      }
    ];
    export async function execute(name, args) {
      return "executed " + name;
    }
    `,
    "utf-8",
  );

  // Initialize with empty plugins/trusted
  await initializePlugins(tempDir, {
    plugins: [pluginFile],
    trustedPlugins: [],
  });
  assert.ok(
    !loadedPlugins.some((p) => p.path === pluginFile),
    "Plugin should not load if not in trustedPlugins",
  );

  // Load with trustedPlugins but approved in global config
  const { loadConfig, saveConfig } = await import("../config.js");
  const globalConfig = loadConfig() as any;
  if (!globalConfig.approvedPlugins) {
    globalConfig.approvedPlugins = [];
  }
  globalConfig.approvedPlugins.push(pluginFile);
  saveConfig(globalConfig);

  // Now run initializePlugins where it is in trustedPlugins and approved
  await initializePlugins(tempDir, {
    plugins: [pluginFile],
    trustedPlugins: [pluginFile],
  });
  assert.ok(
    loadedPlugins.some((p) => p.path === pluginFile),
    "Plugin should load if trusted and approved",
  );
});
