/**
 * truncation-manager.ts — Centralized tool output truncation & disk spillover engine.
 *
 * Inspired by production AI coding CLI architectures (OpenCode tool/truncate.ts).
 * Replaces fragmented, ad-hoc string slices with budgeted truncation that:
 *  1. Preserves critical head and tail output (e.g. test outputs, build logs, diffs).
 *  2. Persists the complete untruncated output to disk (.fixo/spills/).
 *  3. Injects an actionable notification with the saved spill path so the model
 *     or user can inspect exact omitted lines using read_file without exhausting
 *     the context window.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export interface TruncationOptions {
  maxLines?: number;
  maxBytes?: number;
  direction?: "head" | "head-and-tail" | "tail";
  cwd?: string;
  toolName?: string;
}

export interface TruncationResult {
  content: string;
  truncated: boolean;
  totalLines: number;
  totalBytes: number;
  spillPath?: string;
  omittedLines?: number;
}

export const DEFAULT_MAX_LINES = 250;
export const DEFAULT_MAX_BYTES = 40 * 1024; // 40 KiB
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export class TruncationManager {
  /**
   * Determine the directory where full spilled outputs should be saved.
   */
  static getSpillDir(cwd?: string): string {
    if (cwd) {
      const fixoSpillDir = path.join(cwd, ".fixo", "spills");
      try {
        if (!fs.existsSync(fixoSpillDir)) {
          fs.mkdirSync(fixoSpillDir, { recursive: true });
        }
        return fixoSpillDir;
      } catch {
        // Fallback to system temp directory if workspace is not writable
      }
    }

    const tempSpillDir = path.join(os.tmpdir(), "fixo-spills");
    if (!fs.existsSync(tempSpillDir)) {
      fs.mkdirSync(tempSpillDir, { recursive: true });
    }
    return tempSpillDir;
  }

  /**
   * Format tool output within token-safe boundaries, spilling full text to disk if truncated.
   */
  static format(text: string, options: TruncationOptions = {}): TruncationResult {
    if (!text) {
      return {
        content: "",
        truncated: false,
        totalLines: 0,
        totalBytes: 0,
      };
    }

    const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const direction = options.direction ?? "head-and-tail";

    const lines = text.split("\n");
    const totalLines = lines.length;
    const totalBytes = Buffer.byteLength(text, "utf-8");

    if (totalLines <= maxLines && totalBytes <= maxBytes) {
      return {
        content: text,
        truncated: false,
        totalLines,
        totalBytes,
      };
    }

    // Output exceeds budget — save full output to spill directory
    const spillDir = this.getSpillDir(options.cwd);
    const timestamp = Date.now();
    const id = crypto.randomBytes(4).toString("hex");
    const prefix = options.toolName ? `${options.toolName}_` : "tool_";
    const filename = `${prefix}${timestamp}_${id}.log`;
    const spillPath = path.join(spillDir, filename);

    try {
      fs.writeFileSync(spillPath, text, "utf-8");
    } catch {
      // Best-effort write; if failed, proceed with in-memory truncation
    }

    let preview: string;
    let omittedLines = 0;

    if (direction === "head") {
      const kept = lines.slice(0, maxLines);
      omittedLines = totalLines - kept.length;
      preview = [
        ...kept,
        `\n... [Output truncated: ${omittedLines} lines (${Math.round((totalBytes - Buffer.byteLength(kept.join("\n"))) / 1024)} KB) omitted. Full output saved to: ${spillPath}]`,
      ].join("\n");
    } else if (direction === "tail") {
      const kept = lines.slice(-maxLines);
      omittedLines = totalLines - kept.length;
      preview = [
        `... [Output truncated: ${omittedLines} lines omitted. Full output saved to: ${spillPath}]\n`,
        ...kept,
      ].join("\n");
    } else {
      // head-and-tail: preserve top 60% and bottom 40% of maxLines
      const headCount = Math.floor(maxLines * 0.6);
      const tailCount = maxLines - headCount;
      const headLines = lines.slice(0, headCount);
      const tailLines = lines.slice(-tailCount);
      omittedLines = totalLines - (headLines.length + tailLines.length);

      preview = [
        ...headLines,
        `\n... [Output truncated: ${omittedLines} lines (${Math.round(totalBytes / 1024)} KB) omitted. Full output saved to: ${spillPath}. Use read_file with startLine/endLine if needed.] ...\n`,
        ...tailLines,
      ].join("\n");
    }

    return {
      content: preview,
      truncated: true,
      totalLines,
      totalBytes,
      spillPath,
      omittedLines,
    };
  }

  /**
   * Cleans up spilled output logs older than retention period (7 days).
   */
  static cleanupOldSpills(cwd?: string, maxAgeMs: number = RETENTION_MS): number {
    const dir = this.getSpillDir(cwd);
    let removed = 0;
    try {
      const files = fs.readdirSync(dir);
      const now = Date.now();
      for (const file of files) {
        if (!file.endsWith(".log")) continue;
        const fullPath = path.join(dir, file);
        try {
          const stats = fs.statSync(fullPath);
          if (now - stats.mtimeMs > maxAgeMs) {
            fs.unlinkSync(fullPath);
            removed++;
          }
        } catch {
          // Ignore individual file errors
        }
      }
    } catch {
      // Ignore directory read errors
    }
    return removed;
  }
}
