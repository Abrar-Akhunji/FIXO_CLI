/**
 * project-rules.ts — Phase 2 Project Rules Discovery Engine with Folder Trust.
 *
 * Discovers and parses project and user instructions from:
 * 1. Global: ~/.fixocli/rules/*.md and ~/.fixo/rules/*.md
 * 2. Workspace Root: AGENTS.md, agents.md, CLAUDE.md, claude.md
 * 3. Nested / Compat: .fixo/rules/*.md, .cursor/rules/*.md, .claude/rules/*.md
 *
 * Folder Trust:
 * Workspace rules are only loaded if the workspace has been approved by the user.
 * Approved paths are persisted in ~/.fixocli/trusted_workspaces.json.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { getStateDir } from "../config.js";

export interface DiscoveredRule {
  path: string;
  name: string;
  source: "global" | "root" | "nested";
  content: string;
}

export interface TrustedWorkspacesStore {
  trusted: string[];
}

const MAX_RULE_BYTES = 50 * 1024; // 50 KiB limit per rule file

/* ──────────────────────── Folder Trust Storage ──────────────────────── */

export function getTrustedWorkspacesPath(): string {
  return path.join(getStateDir(), "trusted_workspaces.json");
}

function canonicalize(p: string): string {
  try {
    return fs.realpathSync(path.resolve(p));
  } catch {
    return path.resolve(p);
  }
}

export function loadTrustedWorkspaces(): string[] {
  const storePath = getTrustedWorkspacesPath();
  if (!fs.existsSync(storePath)) return [];
  try {
    const raw = fs.readFileSync(storePath, "utf-8");
    const parsed = JSON.parse(raw) as TrustedWorkspacesStore;
    if (Array.isArray(parsed.trusted)) {
      return parsed.trusted.map(canonicalize);
    }
    return [];
  } catch {
    return [];
  }
}

export function saveTrustedWorkspaces(list: string[]): void {
  const storePath = getTrustedWorkspacesPath();
  const dir = path.dirname(storePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const unique = Array.from(new Set(list.map(canonicalize)));
  const data: TrustedWorkspacesStore = { trusted: unique };
  fs.writeFileSync(storePath, JSON.stringify(data, null, 2), "utf-8");
}

export function isWorkspaceTrusted(cwd: string): boolean {
  if (process.env.FIXO_TRUST_ALL === "1") return true;
  const canonical = canonicalize(cwd);
  const trustedList = loadTrustedWorkspaces();
  return trustedList.includes(canonical);
}

export function trustWorkspace(cwd: string): void {
  const canonical = canonicalize(cwd);
  const trustedList = loadTrustedWorkspaces();
  if (!trustedList.includes(canonical)) {
    trustedList.push(canonical);
    saveTrustedWorkspaces(trustedList);
  }
}

export function untrustWorkspace(cwd: string): void {
  const canonical = canonicalize(cwd);
  const trustedList = loadTrustedWorkspaces().filter((item) => item !== canonical);
  saveTrustedWorkspaces(trustedList);
}

export async function promptFolderTrustIfNeeded(
  cwd: string,
  rl?: readline.Interface | null,
): Promise<boolean> {
  if (isWorkspaceTrusted(cwd)) return true;
  if (!rl) return false;

  return new Promise((resolve) => {
    const folderName = path.basename(cwd);
    rl.question(
      `\n⚠️  Workspace "${folderName}" contains project instructions (AGENTS.md/rules). Trust this folder to load them? [y/N]: `,
      (answer) => {
        const trimmed = answer.trim().toLowerCase();
        if (trimmed === "y" || trimmed === "yes") {
          trustWorkspace(cwd);
          resolve(true);
        } else {
          resolve(false);
        }
      },
    );
  });
}

/* ──────────────────────── Rule File Scanning ──────────────────────── */

function safeReadFile(filePath: string): string {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return "";
    const buf = Buffer.alloc(Math.min(stat.size, MAX_RULE_BYTES));
    const fd = fs.openSync(filePath, "r");
    try {
      fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.toString("utf-8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function scanDirForMd(dirPath: string, source: "global" | "nested"): DiscoveredRule[] {
  const results: DiscoveredRule[] = [];
  if (!fs.existsSync(dirPath)) return results;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const fullPath = path.join(dirPath, entry.name);
        const content = safeReadFile(fullPath);
        if (content.trim()) {
          results.push({
            path: fullPath,
            name: entry.name,
            source,
            content,
          });
        }
      }
    }
  } catch {
    // Non-fatal if directory unreadable
  }
  return results;
}

export function loadDiscoveredRules(
  cwd: string,
  trusted?: boolean,
): DiscoveredRule[] {
  const rules: DiscoveredRule[] = [];
  const seenPaths = new Set<string>();

  // 1. Global rules (always loaded regardless of folder trust)
  const globalDirs = [
    path.join(getStateDir(), "rules"),
    path.join(os.homedir(), ".fixo", "rules"),
  ];
  for (const gDir of globalDirs) {
    const found = scanDirForMd(gDir, "global");
    for (const r of found) {
      if (!seenPaths.has(r.path)) {
        seenPaths.add(r.path);
        rules.push(r);
      }
    }
  }

  // Check trust: if not explicitly provided, check workspace trust store
  const isTrusted = trusted !== undefined ? trusted : isWorkspaceTrusted(cwd);
  if (!isTrusted) {
    return rules;
  }

  // 2. Workspace root rules
  const rootCandidates = ["AGENTS.md", "agents.md", "CLAUDE.md", "claude.md"];
  const seenRootGroups = new Set<string>();
  for (const filename of rootCandidates) {
    const group = filename.toLowerCase().startsWith("agents")
      ? "agents"
      : "claude";
    if (seenRootGroups.has(group)) continue;
    const fullPath = path.join(cwd, filename);
    if (fs.existsSync(fullPath)) {
      const content = safeReadFile(fullPath);
      if (content.trim() && !seenPaths.has(fullPath)) {
        seenPaths.add(fullPath);
        seenRootGroups.add(group);
        rules.push({
          path: fullPath,
          name: filename,
          source: "root",
          content,
        });
      }
    }
  }

  // 3. Nested / Compatibility rules
  const nestedDirs = [
    path.join(cwd, ".fixo", "rules"),
    path.join(cwd, ".cursor", "rules"),
    path.join(cwd, ".claude", "rules"),
  ];
  for (const nDir of nestedDirs) {
    const found = scanDirForMd(nDir, "nested");
    for (const r of found) {
      if (!seenPaths.has(r.path)) {
        seenPaths.add(r.path);
        rules.push(r);
      }
    }
  }

  return rules;
}

export function formatProjectRulesBlock(rules: DiscoveredRule[]): string {
  if (rules.length === 0) return "";

  const sections: string[] = [
    "## Project Rules & Agent Instructions",
    "The following project instructions were discovered and loaded for this session:",
  ];

  for (const rule of rules) {
    sections.push(`### Rule: ${rule.name} (${rule.source})\n${rule.content.trim()}`);
  }

  return sections.join("\n\n");
}
