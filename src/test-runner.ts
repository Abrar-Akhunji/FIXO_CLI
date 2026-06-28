import { spawnSync } from "child_process";
import fs from "fs";
import { detectProjectFacts } from "./project-memory.js";
import { redactedEnv, redactSecrets } from "./runtime/redaction.js";
import { WorkspaceGuard } from "./workspace-guard.js";

export function runProjectTests(cwd: string): string {
  const facts = detectProjectFacts(cwd);
  const command = facts.testCommands[0] ?? facts.buildCommands[0];
  if (!command) return "No test or build command detected.";
  return runVerificationCommand(cwd, command);
}

export function runVerificationCommand(cwd: string, command: string): string {
  const [bin, ...args] = command.split(/\s+/);
  const result = spawnSync(bin, args, {
    cwd,
    encoding: "utf-8",
    env: redactedEnv(),
    timeout: 120_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const output = redactSecrets(
    [`$ ${command}`, result.stdout ?? "", result.stderr ?? ""].join("\n"),
  ).trim();
  return summarizeFailure(output, result.status ?? 0);
}

export function parseCiLog(cwd: string, logPath: string): string {
  const guard = new WorkspaceGuard(cwd);
  const file = guard.ensureFile(logPath);
  const raw = redactSecrets(fs.readFileSync(file, "utf-8"));
  return summarizeFailure(
    raw,
    /(?:failed|error|exit code [1-9])/i.test(raw) ? 1 : 0,
  );
}

export function summarizeFailure(output: string, status: number): string {
  const interesting = output
    .split("\n")
    .filter((line) =>
      /error|fail|failed|✗|×|TS\d+|ERR!|AssertionError|TypeError|ReferenceError|SyntaxError/i.test(
        line,
      ),
    )
    .slice(0, 80)
    .join("\n");
  return [
    `Status: ${status}`,
    interesting
      ? `Relevant output:\n${interesting}`
      : `Output:\n${output.slice(0, 4000)}`,
  ].join("\n");
}
