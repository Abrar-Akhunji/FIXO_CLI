import fs from "fs";
import path from "path";
import { createRequire } from "node:module";
import { getWorkspaceStateDir } from "./config.js";

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
let memoryBackend: "sqlite" | "file" = "sqlite";

/** Which store the most recent `getDb` open selected. */
export function getMemoryBackend(): "sqlite" | "file" {
  return memoryBackend;
}

interface MemoryFactRow {
  id: number;
  content: string;
  embedding: string | null;
}

interface MemorySessionRow {
  id: number;
  summary: string;
  embedding: string | null;
}

interface FileMemoryStore {
  facts: MemoryFactRow[];
  sessions: MemorySessionRow[];
  nextFactId: number;
  nextSessionId: number;
}

/**
 * JSON store used when `node:sqlite` is missing (Node 20) or when
 * `FIXO_MEMORY_BACKEND=file`. It implements only the SQL this module runs.
 */
class FileDatabaseSync implements DatabaseSync {
  private store: FileMemoryStore;
  private readonly filePath: string;

  constructor(dbPath: string) {
    this.filePath = path.join(path.dirname(dbPath), "memory.file.json");
    this.store = this.load();
  }

  private emptyStore(): FileMemoryStore {
    return { facts: [], sessions: [], nextFactId: 1, nextSessionId: 1 };
  }

  private load(): FileMemoryStore {
    if (!fs.existsSync(this.filePath)) return this.emptyStore();
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.filePath, "utf-8"),
      ) as Partial<FileMemoryStore>;
      if (!parsed || !Array.isArray(parsed.facts) || !Array.isArray(parsed.sessions)) {
        return this.emptyStore();
      }
      return {
        facts: parsed.facts,
        sessions: parsed.sessions,
        nextFactId: parsed.nextFactId || 1,
        nextSessionId: parsed.nextSessionId || 1,
      };
    } catch {
      return this.emptyStore();
    }
  }

  private flush(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.store), "utf-8");
  }

  exec(sql: string): void {
    const statements = sql
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean);
    for (const statement of statements) {
      if (/^CREATE\s+TABLE/i.test(statement)) continue;
      if (/^DELETE\s+FROM\s+facts$/i.test(statement)) {
        this.store.facts = [];
        continue;
      }
      throw new Error(
        `file memory backend: unsupported statement: ${statement.slice(0, 120)}`,
      );
    }
    this.flush();
  }

  prepare(sql: string): {
    all(...args: unknown[]): unknown[];
    run(...args: unknown[]): void;
    get(...args: unknown[]): unknown;
  } {
    const statement = sql.replace(/\s+/g, " ").trim();
    return {
      all: (...args: unknown[]) => this.queryAll(statement, args),
      run: (...args: unknown[]) => {
        this.queryRun(statement, args);
      },
      get: (...args: unknown[]) => this.queryGet(statement, args),
    };
  }

  close(): void {
    this.flush();
  }

  private queryRun(statement: string, args: unknown[]): void {
    if (statement === "INSERT OR IGNORE INTO facts (content) VALUES (?)") {
      const content = String(args[0] ?? "");
      if (!this.store.facts.some((row) => row.content === content)) {
        this.store.facts.push({
          id: this.store.nextFactId++,
          content,
          embedding: null,
        });
      }
      this.flush();
      return;
    }
    if (statement === "UPDATE facts SET embedding = ? WHERE id = ?") {
      const id = Number(args[1]);
      const row = this.store.facts.find((fact) => fact.id === id);
      if (row) row.embedding = args[0] == null ? null : String(args[0]);
      this.flush();
      return;
    }
    if (statement === "INSERT INTO session_history (summary) VALUES (?)") {
      this.store.sessions.push({
        id: this.store.nextSessionId++,
        summary: String(args[0] ?? ""),
        embedding: null,
      });
      this.flush();
      return;
    }
    throw new Error(`file memory backend: unsupported run: ${statement}`);
  }

  private queryAll(statement: string, _args: unknown[]): unknown[] {
    if (statement === "SELECT id, content, embedding FROM facts") {
      return this.store.facts.map((row) => ({ ...row }));
    }
    if (statement === "SELECT summary FROM session_history ORDER BY id DESC") {
      return [...this.store.sessions]
        .sort((a, b) => b.id - a.id)
        .map((row) => ({ summary: row.summary }));
    }
    if (statement === "SELECT content FROM facts ORDER BY id DESC") {
      return [...this.store.facts]
        .sort((a, b) => b.id - a.id)
        .map((row) => ({ content: row.content }));
    }
    throw new Error(`file memory backend: unsupported all: ${statement}`);
  }

  private queryGet(statement: string, _args: unknown[]): unknown {
    if (statement === "SELECT COUNT(*) as count FROM facts") {
      return { count: this.store.facts.length };
    }
    if (statement === "SELECT COUNT(*) as count FROM session_history") {
      return { count: this.store.sessions.length };
    }
    throw new Error(`file memory backend: unsupported get: ${statement}`);
  }
}

let _DatabaseSyncCtor: (new (path: string) => DatabaseSync) | null = null;

function loadSqliteCtor(): new (path: string) => DatabaseSync {
  if (_DatabaseSyncCtor) return _DatabaseSyncCtor;
  const _require = createRequire(import.meta.url);
  const sqlite = _require("node:sqlite") as {
    DatabaseSync?: new (path: string) => DatabaseSync;
  };
  if (!sqlite?.DatabaseSync) {
    throw new Error("node:sqlite DatabaseSync is missing");
  }
  _DatabaseSyncCtor = sqlite.DatabaseSync;
  return _DatabaseSyncCtor;
}

function openMemoryDatabase(dbPath: string): DatabaseSync {
  if (process.env.FIXO_MEMORY_BACKEND === "file") {
    memoryBackend = "file";
    return new FileDatabaseSync(dbPath);
  }
  try {
    const Ctor = loadSqliteCtor();
    const db = new Ctor(dbPath);
    memoryBackend = "sqlite";
    return db;
  } catch (error: unknown) {
    memoryBackend = "file";
    if (
      process.env.DEBUG ||
      process.env.VERBOSE ||
      process.argv.includes("--verbose")
    ) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(
        `[Memory] node:sqlite unavailable, using file store: ${msg}`,
      );
    }
    return new FileDatabaseSync(dbPath);
  }
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
  dbInstance = openMemoryDatabase(dbPath);

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
  return path.join(getWorkspaceStateDir(cwd), "memory");
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
    getMemoryBackend() === "file"
      ? "Memory store: file (.fixo/memory.file.json)"
      : "Memory store: sqlite (.fixo/memory.db)",
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
