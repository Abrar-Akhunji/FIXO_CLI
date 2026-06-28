import fs from "fs";
import path from "path";

export interface ModelOutcome {
  model: string;
  taskType: string;
  success: boolean;
  latencyMs: number;
  toolCalls: number;
  verificationPassed: boolean | null;
  timestamp: string;
}

const MAX_OUTCOMES = 100;

export function recordModelOutcome(
  cwd: string,
  outcome: Omit<ModelOutcome, "timestamp">,
): void {
  const dir = path.join(cwd, ".fixo");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "model-outcomes.jsonl");
  fs.appendFileSync(
    file,
    JSON.stringify({ ...outcome, timestamp: new Date().toISOString() }) + "\n",
    "utf-8",
  );
  pruneOutcomes(file);
}

function pruneOutcomes(file: string): void {
  try {
    const content = fs.readFileSync(file, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    if (lines.length <= MAX_OUTCOMES) return;
    fs.writeFileSync(
      file,
      lines.slice(lines.length - MAX_OUTCOMES).join("\n") + "\n",
      "utf-8",
    );
  } catch (error: unknown) {
    if (
      process.env.DEBUG ||
      process.env.VERBOSE ||
      process.argv.includes("--verbose")
    ) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(
        `[Debug Warning] Failed to prune model outcomes from ${file}: ${msg}`,
      );
    }
  }
}

export function summarizeModelOutcomes(cwd: string): string {
  const file = path.join(cwd, ".fixo", "model-outcomes.jsonl");
  if (!fs.existsSync(file)) return "No model outcomes recorded.";
  const rows = fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ModelOutcome);
  const byModel = new Map<
    string,
    { total: number; success: number; latency: number; verified: number }
  >();
  for (const row of rows) {
    const entry = byModel.get(row.model) ?? {
      total: 0,
      success: 0,
      latency: 0,
      verified: 0,
    };
    entry.total++;
    if (row.success) entry.success++;
    if (row.verificationPassed) entry.verified++;
    entry.latency += row.latencyMs;
    byModel.set(row.model, entry);
  }
  return Array.from(byModel.entries())
    .map(
      ([model, entry]) =>
        `${model}: ${entry.success}/${entry.total} success, ${entry.verified}/${entry.total} verified, avg ${(entry.latency / entry.total / 1000).toFixed(1)}s`,
    )
    .join("\n");
}
