import fs from 'node:fs';
import path from 'node:path';

/**
 * Phase 4b — Shared per-run file inventory cache.
 * Memoizes listDir and fileStats for the duration of an orchestrator run
 * to reduce redundant fs calls from parallel workers.
 */
export class RunInventory {
  private dirCache = new Map<string, fs.Dirent[]>();
  private statCache = new Map<string, fs.Stats>();
  
  constructor(public readonly runId: string) {}

  listDir(dirPath: string): fs.Dirent[] {
    const cached = this.dirCache.get(dirPath);
    if (cached) return cached;
    
    const list = fs.readdirSync(dirPath, { withFileTypes: true });
    this.dirCache.set(dirPath, list);
    return list;
  }

  fileStats(filePath: string): fs.Stats {
    const cached = this.statCache.get(filePath);
    if (cached) return cached;
    
    const stats = fs.statSync(filePath);
    this.statCache.set(filePath, stats);
    return stats;
  }

  invalidate(filePath: string): void {
    this.statCache.delete(filePath);
    
    // Invalidate the parent directory's listing so it gets re-read
    const parentDir = path.dirname(filePath);
    this.dirCache.delete(parentDir);
    // Also invalidate the file itself in case it was considered a directory
    this.dirCache.delete(filePath);
  }
}

const instances = new Map<string, RunInventory>();

export function getRunInventory(runId: string): RunInventory {
  let inv = instances.get(runId);
  if (!inv) {
    inv = new RunInventory(runId);
    instances.set(runId, inv);
  }
  return inv;
}
