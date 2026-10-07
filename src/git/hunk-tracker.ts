import fs from "node:fs";
import path from "node:path";
import { WorkspaceGuard } from "../workspace-guard.js";

export interface HunkRecord {
  id: string;
  filePath: string;
  relativePath: string;
  timestamp: number;
  beforeContent: string;
  afterContent: string;
  description: string;
  reverted?: boolean;
}

export class HunkTracker {
  private readonly cwd: string;
  private readonly hunks: HunkRecord[] = [];

  constructor(cwd: string) {
    this.cwd = path.resolve(cwd);
  }

  recordHunk(options: {
    cwd?: string;
    filePath: string;
    beforeContent: string;
    afterContent: string;
    description?: string;
  }): HunkRecord {
    const cwd = options.cwd ? path.resolve(options.cwd) : this.cwd;
    const guard = new WorkspaceGuard(cwd);
    const resolved = path.isAbsolute(options.filePath)
      ? options.filePath
      : path.resolve(cwd, options.filePath);
    const relative = guard.relative(resolved);

    const id = `hunk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const record: HunkRecord = {
      id,
      filePath: resolved,
      relativePath: relative,
      timestamp: Date.now(),
      beforeContent: options.beforeContent,
      afterContent: options.afterContent,
      description: options.description || `Mutation on ${relative}`,
      reverted: false,
    };

    this.hunks.push(record);
    return record;
  }

  listHunks(): HunkRecord[] {
    return [...this.hunks];
  }

  getHunk(id: string): HunkRecord | undefined {
    return this.hunks.find((h) => h.id === id);
  }

  revertHunk(id: string): { ok: boolean; message: string; filePath?: string } {
    const hunk = this.hunks.find((h) => h.id === id && !h.reverted);
    if (!hunk) {
      return { ok: false, message: `Hunk ${id} not found or already reverted.` };
    }

    try {
      if (hunk.beforeContent === "") {
        // File was newly created by this hunk; remove it if it exists
        if (fs.existsSync(hunk.filePath)) {
          fs.unlinkSync(hunk.filePath);
        }
      } else {
        const parentDir = path.dirname(hunk.filePath);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }
        fs.writeFileSync(hunk.filePath, hunk.beforeContent, "utf-8");
      }
      hunk.reverted = true;
      return {
        ok: true,
        message: `Reverted hunk ${id} for ${hunk.relativePath}`,
        filePath: hunk.filePath,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        message: `Failed to revert hunk ${id}: ${msg}`,
        filePath: hunk.filePath,
      };
    }
  }

  revertLastHunk(): { ok: boolean; message: string; filePath?: string } {
    for (let i = this.hunks.length - 1; i >= 0; i--) {
      const hunk = this.hunks[i];
      if (!hunk.reverted) {
        return this.revertHunk(hunk.id);
      }
    }
    return { ok: false, message: "No active hunks available to revert." };
  }

  clear(): void {
    this.hunks.length = 0;
  }
}

const trackerInstances = new Map<string, HunkTracker>();

export function getHunkTracker(cwd: string): HunkTracker {
  const norm = path.resolve(cwd);
  let tracker = trackerInstances.get(norm);
  if (!tracker) {
    tracker = new HunkTracker(norm);
    trackerInstances.set(norm, tracker);
  }
  return tracker;
}
