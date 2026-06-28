import fs from "fs";
import path from "path";
import { createRequire } from "node:module";

export interface ProjectFacts {
  packageManager: "npm" | "pnpm" | "yarn" | "unknown";
  scripts: Record<string, string>;
  testCommands: string[];
  buildCommands: string[];
  tsconfigs: string[];
  updatedAt: string;
  allowRules: {
    commands: string[];
  };
}

export function detectProjectFacts(cwd: string): ProjectFacts {
  const packageJson = path.join(cwd, "package.json");
  let scripts: Record<string, string> = {};
  if (fs.existsSync(packageJson)) {
    try {
      scripts = JSON.parse(fs.readFileSync(packageJson, "utf-8")).scripts ?? {};
    } catch (error: unknown) {
      if (
        process.env.DEBUG ||
        process.env.VERBOSE ||
        process.argv.includes("--verbose")
      ) {
        const msg = error instanceof Error ? error.message : String(error);
        console.warn(
          `[Debug Warning] Failed to parse package.json scripts: ${msg}`,
        );
      }
      scripts = {};
    }
  }
  const packageManager = fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))
    ? "pnpm"
    : fs.existsSync(path.join(cwd, "yarn.lock"))
      ? "yarn"
      : fs.existsSync(path.join(cwd, "package-lock.json"))
        ? "npm"
        : "unknown";
  const prefix = packageManager === "unknown" ? "npm" : packageManager;
  return {
    packageManager,
    scripts,
    testCommands: Object.keys(scripts)
      .filter((k) => /test|check|typecheck/.test(k))
      .map((k) => `${prefix} run ${k}`),
    buildCommands: Object.keys(scripts)
      .filter((k) => /build/.test(k))
      .map((k) => `${prefix} run ${k}`),
    tsconfigs: findFiles(cwd, /^tsconfig.*\.json$/).slice(0, 20),
    updatedAt: new Date().toISOString(),
    allowRules: readAllowRules(cwd),
  };
}

import { colors } from "./ui/colors.js";

/** Minimal interface for the subset of Node.js built-in SQLite API we use. */
interface DatabaseSync {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...args: unknown[]): unknown[];
    run(...args: unknown[]): void;
    get(...args: unknown[]): unknown;
  };
  close?(): void;
}

let dbInstance: DatabaseSync | null = null;
let lastCwd = "";

let _DatabaseSyncCtor: (new (path: string) => DatabaseSync) | null = null;
function getDatabaseSync(): new (path: string) => DatabaseSync {
  if (!_DatabaseSyncCtor) {
    const _require = createRequire(import.meta.url);
    const sqlite = _require("node:sqlite");
    _DatabaseSyncCtor = sqlite.DatabaseSync;
  }
  return _DatabaseSyncCtor!;
}

export function getDb(cwd: string): DatabaseSync {
  const dir = memoryDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "memory.db");

  if (dbInstance && lastCwd === cwd) {
    return dbInstance;
  }

  if (dbInstance) {
    try {
      dbInstance.close?.();
    } catch (error: unknown) {
      if (
        process.env.DEBUG ||
        process.env.VERBOSE ||
        process.argv.includes("--verbose")
      ) {
        const msg = error instanceof Error ? error.message : String(error);
        console.warn(
          `[Debug Warning] Failed to close database instance: ${msg}`,
        );
      }
    }
  }

  lastCwd = cwd;
  const DatabaseSync = getDatabaseSync();
  dbInstance = new DatabaseSync(dbPath);

  // Initialize tables
  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL UNIQUE,
      embedding TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS session_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      summary TEXT NOT NULL,
      embedding TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Migrate legacy memory.md if present
  const memoryFile = path.join(dir, "memory.md");
  if (fs.existsSync(memoryFile)) {
    try {
      const content = fs.readFileSync(memoryFile, "utf-8");
      const lines = content.split("\n");
      const insertStmt = dbInstance.prepare(`
        INSERT OR IGNORE INTO facts (content) VALUES (?)
      `);

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
          const fact = trimmed.slice(2).trim();
          if (fact && fact !== "FixO Project Memory") {
            insertStmt.run(fact);
          }
        }
      }

      fs.renameSync(memoryFile, path.join(dir, "memory.md.migrated"));
    } catch (err) {
      console.warn(
        `[Memory Migration] Warning: Failed to migrate legacy memory.md: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return dbInstance;
}

export function calculateTfidfSimilarity(
  query: string,
  documents: string[],
): number[] {
  if (documents.length === 0) return [];

  const tokenize = (text: string): string[] => {
    return text.toLowerCase().match(/[a-z0-9]+/g) || [];
  };

  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    return new Array(documents.length).fill(0);
  }

  const docTokensList = documents.map((doc) => tokenize(doc));
  const numDocs = documents.length;

  const allUniqueTokens = new Set([...queryTokens, ...docTokensList.flat()]);
  const df: Record<string, number> = {};
  for (const token of allUniqueTokens) {
    let count = 0;
    for (const docTokens of docTokensList) {
      if (docTokens.includes(token)) {
        count++;
      }
    }
    df[token] = count;
  }

  const idf: Record<string, number> = {};
  for (const token of allUniqueTokens) {
    idf[token] = Math.log(1 + numDocs / (df[token] || 1));
  }

  const getVector = (tokens: string[]): Record<string, number> => {
    const tf: Record<string, number> = {};
    for (const token of tokens) {
      tf[token] = (tf[token] || 0) + 1;
    }
    const vector: Record<string, number> = {};
    for (const token in tf) {
      if (idf[token] !== undefined) {
        vector[token] = tf[token] * idf[token];
      }
    }
    return vector;
  };

  const queryVector = getVector(queryTokens);

  const magnitude = (vec: Record<string, number>): number => {
    let sum = 0;
    for (const val of Object.values(vec)) {
      sum += val * val;
    }
    return Math.sqrt(sum);
  };

  const queryMag = magnitude(queryVector);
  if (queryMag === 0) {
    return new Array(documents.length).fill(0);
  }

  return docTokensList.map((docTokens) => {
    if (docTokens.length === 0) return 0;
    const docVector = getVector(docTokens);
    const docMag = magnitude(docVector);
    if (docMag === 0) return 0;

    let dotProduct = 0;
    for (const token in queryVector) {
      if (docVector[token]) {
        dotProduct += queryVector[token] * docVector[token];
      }
    }

    return dotProduct / (queryMag * docMag);
  });
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function retrieveRelevantFacts(
  cwd: string,
  query: string,
  client?: any,
  limit = 5,
): Promise<string[]> {
  const db = getDb(cwd);
  const allRows = db
    .prepare("SELECT id, content, embedding FROM facts")
    .all() as { id: number; content: string; embedding: string | null }[];
  if (allRows.length === 0) return [];

  if (client) {
    try {
      const queryEmbedding = await client.getEmbedding(query);
      if (queryEmbedding && Array.isArray(queryEmbedding)) {
        const updateStmt = db.prepare(
          "UPDATE facts SET embedding = ? WHERE id = ?",
        );
        const similarities: { content: string; similarity: number }[] = [];

        for (const row of allRows) {
          let factEmbedding: number[] | null = null;
          if (row.embedding) {
            try {
              factEmbedding = JSON.parse(row.embedding);
            } catch (error: unknown) {
              if (
                process.env.DEBUG ||
                process.env.VERBOSE ||
                process.argv.includes("--verbose")
              ) {
                const msg =
                  error instanceof Error ? error.message : String(error);
                console.warn(
                  `[Debug Warning] Failed to parse fact embedding JSON for ID ${row.id}: ${msg}`,
                );
              }
            }
          }

          if (!factEmbedding) {
            try {
              factEmbedding = await client.getEmbedding(row.content);
              if (factEmbedding) {
                updateStmt.run(JSON.stringify(factEmbedding), row.id);
              }
            } catch (err) {
              if (client.verbose) {
                console.warn(
                  `[Memory] Failed to compute embedding for fact ID ${row.id}: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            }
          }

          if (factEmbedding) {
            const sim = cosineSimilarity(queryEmbedding, factEmbedding);
            similarities.push({ content: row.content, similarity: sim });
          } else {
            similarities.push({ content: row.content, similarity: 0 });
          }
        }

        similarities.sort((a, b) => b.similarity - a.similarity);
        return similarities.slice(0, limit).map((s) => s.content);
      }
    } catch (err) {
      console.warn(
        `${colors.yellow}Warning: Embeddings API failed. Falling back to local TF-IDF memory retrieval. Error: ${err instanceof Error ? err.message : String(err)}${colors.reset}`,
      );
    }
  }

  try {
    const docContents = allRows.map((r) => r.content);
    const sims = calculateTfidfSimilarity(query, docContents);
    const factsWithSim = allRows.map((row, idx) => ({
      content: row.content,
      similarity: sims[idx] || 0,
    }));

    factsWithSim.sort((a, b) => b.similarity - a.similarity);
    return factsWithSim.slice(0, limit).map((s) => s.content);
  } catch (err) {
    console.error(
      `${colors.red}Error: Local TF-IDF search failed. ${err instanceof Error ? err.message : String(err)}${colors.reset}`,
    );
    return allRows.slice(0, limit).map((r) => r.content);
  }
}

export function appendSessionSummary(cwd: string, summary: string): void {
  const db = getDb(cwd);
  const stmt = db.prepare("INSERT INTO session_history (summary) VALUES (?)");
  stmt.run(summary.trim());
}

export function readSessionHistory(cwd: string): string[] {
  const db = getDb(cwd);
  const stmt = db.prepare(
    "SELECT summary FROM session_history ORDER BY id DESC",
  );
  const rows = stmt.all() as { summary: string }[];
  return rows.map((r) => r.summary);
}

export function memoryDir(cwd: string): string {
  return path.join(cwd, ".fixo");
}

export function ensureProjectMemory(cwd: string): ProjectFacts {
  const dir = memoryDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const projectFile = path.join(dir, "project.json");
  const facts = detectProjectFacts(cwd);
  fs.writeFileSync(projectFile, JSON.stringify(facts, null, 2) + "\n", "utf-8");
  getDb(cwd); // Ensures DB is created and tables are initialized
  return facts;
}

export function readMemory(cwd: string): string {
  ensureProjectMemory(cwd);
  const db = getDb(cwd);
  const rows = db
    .prepare("SELECT content FROM facts ORDER BY id DESC")
    .all() as { content: string }[];
  if (rows.length === 0) {
    return "";
  }
  return rows.map((r) => `- ${r.content}`).join("\n");
}

export function appendMemory(cwd: string, text: string): void {
  ensureProjectMemory(cwd);
  const db = getDb(cwd);
  const stmt = db.prepare("INSERT OR IGNORE INTO facts (content) VALUES (?)");
  stmt.run(text.trim());
}

export function readAllowRules(cwd: string): { commands: string[] } {
  const file = path.join(memoryDir(cwd), "allow-rules.json");
  if (!fs.existsSync(file)) return { commands: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as {
      commands?: string[];
    };
    return {
      commands: Array.isArray(parsed.commands)
        ? parsed.commands.filter(Boolean)
        : [],
    };
  } catch (error: unknown) {
    if (
      process.env.DEBUG ||
      process.env.VERBOSE ||
      process.argv.includes("--verbose")
    ) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(
        `[Debug Warning] Failed to read or parse allow-rules.json from ${file}: ${msg}`,
      );
    }
    return { commands: [] };
  }
}

export function allowCommand(cwd: string, command: string): void {
  const dir = memoryDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const rules = readAllowRules(cwd);
  if (!rules.commands.includes(command.trim()))
    rules.commands.push(command.trim());
  fs.writeFileSync(
    path.join(dir, "allow-rules.json"),
    JSON.stringify(rules, null, 2) + "\n",
    "utf-8",
  );
}

export function forgetMemory(cwd: string): void {
  const db = getDb(cwd);
  db.exec("DELETE FROM facts");
}

export function doctor(cwd: string): string {
  const facts = ensureProjectMemory(cwd);
  const db = getDb(cwd);
  const factsCount = (
    db.prepare("SELECT COUNT(*) as count FROM facts").get() as { count: number }
  ).count;
  const sessionsCount = (
    db.prepare("SELECT COUNT(*) as count FROM session_history").get() as {
      count: number;
    }
  ).count;

  const lines = [
    "FixO Doctor",
    `Package manager: ${facts.packageManager}`,
    `Scripts: ${Object.keys(facts.scripts).length}`,
    `Build commands: ${facts.buildCommands.join(", ") || "(none)"}`,
    `Test commands: ${facts.testCommands.join(", ") || "(none)"}`,
    `TypeScript configs: ${facts.tsconfigs.join(", ") || "(none)"}`,
    `SQLite Database: ok (.fixo/memory.db)`,
    `Stored Facts: ${factsCount}`,
    `Stored Sessions: ${sessionsCount}`,
    `Allowed commands: ${facts.allowRules.commands.join(", ") || "(none)"}`,
  ];
  return lines.join("\n");
}

function findFiles(root: string, pattern: RegExp): string[] {
  const result: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (
        entry.name === "node_modules" ||
        entry.name === ".git" ||
        entry.name === "dist"
      )
        continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (pattern.test(entry.name)) result.push(path.relative(root, full));
    }
  };
  walk(root);
  return result;
}
