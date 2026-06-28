import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

export function reviewWorkspace(cwd: string): string {
  const diff = getDiff(cwd);
  if (!diff.trim()) return "No diff to review.";
  const findings: string[] = [];
  const lines = diff.split("\n");
  for (const [idx, line] of lines.entries()) {
    if (/execSync\(`|execSync\([^'"]/.test(line)) {
      findings.push(
        `P1 command-injection risk near diff line ${idx + 1}: shell command construction should use argument arrays.`,
      );
    }
    if (/startsWith\(.*cwd|startsWith\(.*root/.test(line)) {
      findings.push(
        `P1 path-boundary risk near diff line ${idx + 1}: prefix checks can be bypassed by sibling paths.`,
      );
    }
    if (/reset --hard/.test(line)) {
      findings.push(
        `P1 data-loss risk near diff line ${idx + 1}: hard reset should not be used for user-facing undo.`,
      );
    }
    if (
      /writeFileSync|unlinkSync|renameSync/.test(line) &&
      !/TaskSession|WorkspaceGuard/.test(line)
    ) {
      findings.push(
        `P2 mutation audit gap near diff line ${idx + 1}: file mutation should be ledgered and workspace-guarded.`,
      );
    }
    if (
      /api[_-]?key|token|secret|password/i.test(line) &&
      line.startsWith("+")
    ) {
      findings.push(
        `P1 possible secret exposure near diff line ${idx + 1}: added credential-like text should be redacted or moved to secure config.`,
      );
    }
    if (
      /initialValue:\s*true/.test(line) &&
      /confirm/.test(lines[Math.max(0, idx - 2)] + line)
    ) {
      findings.push(
        `P2 unsafe confirmation default near diff line ${idx + 1}: dangerous prompts should default to No.`,
      );
    }
  }
  for (const file of changedFiles(cwd)) {
    if (file.endsWith(".ts") && fs.existsSync(path.join(cwd, file))) {
      const content = fs.readFileSync(path.join(cwd, file), "utf-8");
      if (/TODO|placeholder|not available yet/i.test(content)) {
        findings.push(
          `P3 incomplete implementation marker in ${file}: remove placeholders from production paths.`,
        );
      }
    }
  }
  if (findings.length === 0) {
    findings.push(
      "No high-confidence issues found by local static review. Residual risk: semantic bugs still require model/human review.",
    );
  }
  return ["Human-Grade Review", ...findings.map((f) => `- ${f}`)].join("\n");
}

function getDiff(cwd: string): string {
  try {
    return execFileSync("git", ["diff", "--", "."], {
      cwd,
      encoding: "utf-8",
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch {
    return "";
  }
}

function changedFiles(cwd: string): string[] {
  try {
    return execFileSync("git", ["diff", "--name-only", "--", "."], {
      cwd,
      encoding: "utf-8",
    })
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}
