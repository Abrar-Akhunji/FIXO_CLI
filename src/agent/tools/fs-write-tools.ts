import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { colors } from "../../ui/colors.js";
import { WorkspaceGuard, PlatformPathLockedError } from "../../workspace-guard.js";
import type { TaskSession } from "../../runtime/task-session.js";
import type { ToolExecutionOptions } from "./types.js";
import { applyAtomicWrite, isSensitiveCredentialPath } from "./fs-support.js";

export function executeWriteFile(
  filePath: string,
  content: string,
  cwd: string,
  options: ToolExecutionOptions = {},
): Promise<string> {
  const guard = new WorkspaceGuard(cwd);
  const resolved = guard.resolve(filePath, "file", false);

  if (isSensitiveCredentialPath(resolved)) {
    return Promise.resolve(
      `Error: Access to sensitive file "${filePath}" is blocked for security reasons.`,
    );
  }
  try {
    guard.assertNotPlatformPath(resolved);
  } catch (err: unknown) {
    if (err instanceof PlatformPathLockedError) {
      return Promise.resolve(err.message);
    }
    throw err;
  }
  const mutation = options.session?.canMutate(resolved);
  if (mutation && !mutation.ok)
    return Promise.resolve(`Error: ${mutation.reason}`);
  options.session?.captureBefore(resolved);
  const existed = fs.existsSync(resolved);

  return applyAtomicWrite(
    cwd,
    filePath,
    content,
    options.safety,
    options.session,
  ).then(() => {
    if (!existed) return `File created: ${filePath}`;
    try {
      const relativePath = guard.relative(resolved);
      const result = spawnSync(
        "git",
        ["diff", "--color=always", "--", relativePath],
        { cwd, encoding: "utf-8" },
      );
      if (result.status === 0 && result.stdout) {
        const diffOutput = result.stdout.trim();
        if (diffOutput) {
          console.log(
            `\n${colors.cyan}--- File Changes Diff ---${colors.reset}`,
          );
          const lines = diffOutput.split("\n");
          if (lines.length > 50) {
            console.log(
              lines.slice(0, 48).join("\n") +
                `\n${colors.yellow}... (diff truncated)${colors.reset}`,
            );
          } else {
            console.log(diffOutput);
          }
          console.log(
            `${colors.cyan}-------------------------${colors.reset}\n`,
          );
        }
      }
    } catch {
      // Fail-safe diff printing
    }
    return `File updated: ${filePath}`;
  });
}

export function executeDeleteFile(
  filePath: string,
  cwd: string,
  session?: TaskSession,
): string {
  const guard = new WorkspaceGuard(cwd);
  let resolved: string;
  try {
    resolved = guard.resolve(filePath, "file", true);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error: ${msg}`;
  }

  try {
    guard.assertNotPlatformPath(resolved);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error: ${msg}`;
  }

  if (isSensitiveCredentialPath(resolved)) {
    const filename = path.basename(resolved).toLowerCase();
    return `Error: Cannot delete sensitive configuration or credentials file: ${filename}`;
  }

  const mutation = session?.canMutate(resolved);
  if (mutation && !mutation.ok) return `Error: ${mutation.reason}`;
  session?.captureBefore(resolved);
  if (!fs.existsSync(resolved)) {
    return `Error: File not found: ${filePath}`;
  }
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    return `Error: "${filePath}" is a directory. delete_file can only delete files.`;
  }

  fs.unlinkSync(resolved);
  session?.noteChange(resolved);
  return `File deleted: ${filePath}`;
}

export function filesFromPatch(patch: string): string[] {
  const files = new Set<string>();
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ b/")) files.add(line.slice(6));
    else if (line.startsWith("--- a/")) files.add(line.slice(6));
  }
  return Array.from(files).filter((file) => file !== "/dev/null");
}

export function executeApplyPatch(
  patch: string,
  cwd: string,
  options: ToolExecutionOptions = {},
): Promise<string> {
  if (!patch?.trim()) return Promise.resolve("Error: patch is required.");
  const guard = new WorkspaceGuard(cwd);
  for (const file of filesFromPatch(patch)) {
    try {
      const resolved = guard.resolve(file, "patch target", true);
      guard.assertNotPlatformPath(resolved);
    } catch (err: unknown) {
      if (err instanceof PlatformPathLockedError) {
        return Promise.resolve(err.message);
      }
      if (err instanceof Error) {
        return Promise.resolve(`Error: ${err.message}`);
      }
      throw err;
    }
  }
  for (const file of filesFromPatch(patch)) {
    try {
      options.session?.captureBefore(file);
    } catch {
      /* best effort */
    }
  }
  const result = spawnSync("git", ["apply", "--whitespace=nowarn", "-"], {
    cwd,
    input: patch,
    encoding: "utf-8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0)
    return Promise.resolve(`Patch failed:\n${result.stderr || result.stdout}`);
  for (const file of filesFromPatch(patch)) {
    try {
      options.session?.noteChange(file);
    } catch {
      /* best effort */
    }
  }
  return Promise.resolve("Patch applied.");
}

export function executeReplaceRange(
  filePath: string,
  startLine: number,
  endLine: number,
  content: string,
  cwd: string,
  options: ToolExecutionOptions = {},
): Promise<string> {
  const guard = new WorkspaceGuard(cwd);
  const resolved = guard.resolve(filePath, "file", false);
  try {
    guard.assertNotPlatformPath(resolved);
  } catch (err: unknown) {
    if (err instanceof PlatformPathLockedError)
      return Promise.resolve(err.message);
    throw err;
  }
  const mutation = options.session?.canMutate(resolved);
  if (mutation && !mutation.ok)
    return Promise.resolve(`Error: ${mutation.reason}`);
  options.session?.captureBefore(resolved);
  const original = fs.readFileSync(resolved, "utf-8");
  const lines = original.split("\n");
  if (
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine ||
    endLine > lines.length
  ) {
    return Promise.resolve(
      `Error: invalid line range ${startLine}-${endLine}.`,
    );
  }
  lines.splice(startLine - 1, endLine - startLine + 1, ...content.split("\n"));
  return applyAtomicWrite(
    cwd,
    filePath,
    lines.join("\n"),
    options.safety,
    options.session,
  ).then(() => `Replaced ${filePath}:${startLine}-${endLine}.`);
}

export function executeInsertAfter(
  filePath: string,
  anchor: string,
  content: string,
  cwd: string,
  options: ToolExecutionOptions = {},
): Promise<string> {
  const guard = new WorkspaceGuard(cwd);
  const resolved = guard.resolve(filePath, "file", false);
  try {
    guard.assertNotPlatformPath(resolved);
  } catch (err: unknown) {
    if (err instanceof PlatformPathLockedError)
      return Promise.resolve(err.message);
    throw err;
  }
  const mutation = options.session?.canMutate(resolved);
  if (mutation && !mutation.ok)
    return Promise.resolve(`Error: ${mutation.reason}`);
  options.session?.captureBefore(resolved);
  const original = fs.readFileSync(resolved, "utf-8");
  const idx = original.indexOf(anchor);
  if (idx === -1)
    return Promise.resolve(`Error: anchor not found in ${filePath}.`);
  const insertAt = idx + anchor.length;
  const next = original.slice(0, insertAt) + content + original.slice(insertAt);
  return applyAtomicWrite(
    cwd,
    filePath,
    next,
    options.safety,
    options.session,
  ).then(() => `Inserted content in ${filePath}.`);
}

export function executeRenameFile(
  from: string,
  to: string,
  cwd: string,
  options: ToolExecutionOptions = {},
): Promise<string> {
  const guard = new WorkspaceGuard(cwd);
  const source = guard.resolve(from, "source file", true);
  const target = guard.resolve(to, "target file", true);
  try {
    guard.assertNotPlatformPath(source);
    guard.assertNotPlatformPath(target);
  } catch (err: unknown) {
    if (err instanceof PlatformPathLockedError)
      return Promise.resolve(err.message);
    throw err;
  }
  const mutation = options.session?.canMutate(source);
  if (mutation && !mutation.ok)
    return Promise.resolve(`Error: ${mutation.reason}`);
  options.session?.captureBefore(source);
  options.session?.captureBefore(target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(source, target);
  options.session?.noteChange(source);
  options.session?.noteChange(target);
  return Promise.resolve(`Renamed ${from} -> ${to}.`);
}
