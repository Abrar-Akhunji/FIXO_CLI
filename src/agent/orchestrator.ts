import fs from "fs";
import path from "path";
import type { AgentContext, Subtask, TaskDAG } from "../types.js";
import { AgentClient } from "./agent-client.js";
import { loadConfig, getAgentDagConfig } from "../config.js";
import { C } from "../ui/colors.js";
import { globToRegExp } from "./permissions.js";
import { telemetry, recordTelemetry } from "./telemetry.js";

/**
 * Phase 5.3 — Subtask personas that may write to the workspace.
 *
 * Reviewer is read-only (it produces a verdict, not a diff). Code,
 * test, and doc personas all have plausible write-shaped tool calls —
 * `test` writes test files, `doc` writes README/JSDoc, and `code` is
 * the obvious case. Only pairs of MUTATING_PERSONAS members are
 * candidates for write-conflict serialization.
 */
const MUTATING_PERSONAS: ReadonlySet<Subtask["persona"]> = new Set([
  "code",
  "test",
  "doc",
]);

/**
 * Phase 5.3 — could the two file references possibly resolve to the
 * same on-disk path?
 *
 * Pure-string match is the easy case. When either side is a glob
 * (contains `*` or `?`), we test the glob against the literal. When
 * BOTH sides are globs we punt and return true — pattern-vs-pattern
 * overlap is undecidable cheaply, and conservative serialization is
 * the explicit Phase 5.3 default.
 */
export function couldOverlapFile(a: string, b: string): boolean {
  if (a === b) return true;
  const aIsGlob = a.includes("*") || a.includes("?");
  const bIsGlob = b.includes("*") || b.includes("?");
  if (aIsGlob && bIsGlob) return true; // can't cheaply decide; conservative
  if (aIsGlob) return globToRegExp(a).test(b);
  if (bIsGlob) return globToRegExp(b).test(a);
  return false;
}

function fileSetsCouldOverlap(
  filesA: readonly string[],
  filesB: readonly string[],
): boolean {
  for (const a of filesA) {
    for (const b of filesB) {
      if (couldOverlapFile(a, b)) return true;
    }
  }
  return false;
}

/**
 * Phase 5.3 — DAG post-pass that injects dependency edges between
 * subtasks whose write-sets could conflict.
 *
 * Algorithm:
 *   1. Iterate subtasks in deterministic `id`-lexicographic order.
 *   2. For each pair (a, b) where a < b and both are write-shaped:
 *      a. If they're already directly ordered (a depends on b OR b
 *         depends on a), skip.
 *      b. If both declare non-empty `files` AND those sets could
 *         overlap → serialize b after a.
 *      c. If either declares empty `files` AND `serializeMissingFiles`
 *         is true → serialize b after a (conservative: can't prove
 *         disjoint write sets).
 *   3. Each insertion is logged to telemetry so we can observe how
 *      often the conflict pass kicks in.
 *
 * Mutates the subtasks array in place (consistent with
 * `validateAndSortDAG` style) and returns the inserted edges for
 * observability.
 */
export interface WriteConflictPlan {
  /** Same array reference as input, with `dependencies` mutated. */
  subtasks: Subtask[];
  /** Edges injected by this pass; `from` blocks `to`. */
  edgesInserted: Array<{ from: string; to: string; reason: string }>;
}

export function serializeWriteConflicts(
  subtasks: Subtask[],
  options: { serializeMissingFiles?: boolean } = {},
): WriteConflictPlan {
  const serializeMissingFiles = options.serializeMissingFiles ?? true;
  const edges: Array<{ from: string; to: string; reason: string }> = [];

  // Deterministic order — lexicographic `id`. Stable across runs so
  // a re-plan produces the same DAG.
  const ordered = [...subtasks].sort((a, b) => a.id.localeCompare(b.id));

  for (let i = 0; i < ordered.length; i++) {
    const a = ordered[i];
    if (!MUTATING_PERSONAS.has(a.persona)) continue;
    for (let j = i + 1; j < ordered.length; j++) {
      const b = ordered[j];
      if (!MUTATING_PERSONAS.has(b.persona)) continue;

      // Skip if already directly ordered (in either direction).
      if (b.dependencies.includes(a.id) || a.dependencies.includes(b.id))
        continue;

      const aFiles = a.files ?? [];
      const bFiles = b.files ?? [];
      let reason: string | null = null;
      let conflictKey = "";

      if (aFiles.length > 0 && bFiles.length > 0) {
        if (fileSetsCouldOverlap(aFiles, bFiles)) {
          // Find a representative overlapping pair for telemetry.
          outer: for (const x of aFiles) {
            for (const y of bFiles) {
              if (couldOverlapFile(x, y)) {
                conflictKey = x === y ? x : `${x} ↔ ${y}`;
                break outer;
              }
            }
          }
          reason = `shared write target (${conflictKey})`;
        }
      } else if (serializeMissingFiles) {
        reason =
          aFiles.length === 0 && bFiles.length === 0
            ? `both subtasks declared no files; conservative serialization`
            : `one subtask declared no files; conservative serialization`;
        conflictKey = "<unknown>";
      }

      if (reason) {
        b.dependencies = [...b.dependencies, a.id];
        edges.push({ from: a.id, to: b.id, reason });
        try {
          recordTelemetry(
            telemetry.dagWriteSetConflictAvoided({
              runId: "plan-time",
              file: conflictKey,
              serializedSubtasks: [a.id, b.id],
            }),
          );
        } catch {
          // telemetry must never break planning
        }
      }
    }
  }

  return { subtasks, edgesInserted: edges };
}

export class Orchestrator {
  private client: AgentClient;
  private verbose: boolean;
  public tokensUsed = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };

  constructor(verbose = false) {
    const config = loadConfig();
    this.client = new AgentClient(
      config.freellmapi_api_key || "",
      config.apiUrl,
      verbose,
      config.provider_mode,
      config.preferences.modelRouting,
    );
    this.verbose = verbose;
  }

  async plan(context: AgentContext): Promise<TaskDAG> {
    const workspaceRoot = context.cwd;
    const projectName = path.basename(workspaceRoot);
    let dirListing = "";
    try {
      const files = fs.readdirSync(workspaceRoot, { withFileTypes: true });
      dirListing = files
        .filter((f) => !f.name.startsWith(".") || f.name === ".env.example")
        .map((f) => (f.isDirectory() ? `${f.name}/` : f.name))
        .join(", ");
    } catch (e) {
      dirListing = "Unknown";
    }

    const systemPrompt = `You are the FixO Orchestrator. Your job is to analyze a complex software engineering task and decompose it into a Directed Acyclic Graph (DAG) of subtasks.
Each subtask will be assigned to a specialist worker agent:
- 'code': Writes or modifies code files.
- 'test': Creates, updates, or executes test suites.
- 'doc': Updates documentation, READMEs, JSDocs, etc.
- 'reviewer': Reviews changes, audits code modifications.

Context Variables:
- Current Workspace Root: ${workspaceRoot}
- Project Name: ${projectName}
- Workspace Top-level Directory Listing: ${dirListing}
- User's Exact Query/Task Description: ${context.task}

You are analyzing the USER'S PROJECT at ${workspaceRoot}. The project name is ${projectName}. You must ONLY generate subtasks relevant to the user's project and their request. Do NOT analyze or reference the Fixo CLI's own internal source code or architecture. The user's files are at ${workspaceRoot}.

You must output a single valid JSON object containing a "subtasks" array. NO markdown formatting, NO backticks, and NO conversational text.

JSON Schema:
{
  "subtasks": [
    {
      "id": "string",
      "title": "string",
      "description": "string",
      "persona": "code" | "test" | "doc" | "reviewer",
      "dependencies": ["string"],
      "files": ["string"]
    }
  ]
}`;

    const maxRetries = 3;
    let attempt = 0;
    let feedback = "";

    while (attempt < maxRetries) {
      if (attempt > 0) {
        const delayMs = Math.pow(2, attempt) * 1000;
        if (this.verbose) {
          console.log(
            `[Orchestrator] Retrying plan generation in ${(delayMs / 1000).toFixed(1)}s...`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      try {
        const response = await this.client.chat(
          [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content:
                context.task +
                (feedback
                  ? `\n\nPrevious attempt failed validation: ${feedback}. Please output only valid JSON matching the schema.`
                  : ""),
            },
          ],
          context.model,
          { agent_task_type: "investigation", required_capabilities: ["fast"] },
        );

        if (response.usage) {
          this.tokensUsed.prompt_tokens += response.usage.prompt_tokens;
          this.tokensUsed.completion_tokens += response.usage.completion_tokens;
          this.tokensUsed.total_tokens += response.usage.total_tokens;
        }

        const content = response.content?.trim() || "";
        const jsonMatch = content.match(/\{[\s\S]*\}/);

        if (jsonMatch) {
          const rawLength = content.length;
          const matchLength = jsonMatch[0].length;
          if (rawLength - matchLength > 50) {
            throw new Error(
              `Model output contained too much conversational text (${rawLength - matchLength} chars outside JSON). Please output STRICTLY JSON without any conversational text or markdown formatting.`,
            );
          }
        } else {
          throw new Error("No JSON object found in response.");
        }

        const parsed = JSON.parse(jsonMatch[0]) as TaskDAG;

        if (parsed && Array.isArray(parsed.subtasks)) {
          // Validation step for workspace context leaks
          const isFixoCliSelf = projectName === "FIXO_CLI";
          if (!isFixoCliSelf) {
            const hasFixoReference = parsed.subtasks.some((s) => {
              const titleUpper = s.title.toUpperCase();
              const descUpper = s.description.toUpperCase();
              return (
                titleUpper.includes("FIXO") ||
                titleUpper.includes("ORCHESTRATOR") ||
                titleUpper.includes("CLI CORE") ||
                descUpper.includes("FIXO") ||
                descUpper.includes("ORCHESTRATOR") ||
                descUpper.includes("CLI CORE")
              );
            });
            if (hasFixoReference) {
              throw new Error(
                `Plan contains references to Fixo/Orchestrator/CLI architecture, but we are analyzing a user project at ${workspaceRoot}. Generate subtasks relevant only to the user project.`,
              );
            }
          }

          this.validateAndSortDAG(parsed.subtasks);
          // Phase 5.3 — inject write-conflict edges. Default is to
          // serialize on both observed overlap AND declared-empty
          // file sets (LLMs frequently omit `files`). The flag lives
          // under `agent.dag.serializeWriteConflicts`.
          const dagCfg = getAgentDagConfig();
          if (dagCfg.serializeWriteConflicts) {
            const { edgesInserted } = serializeWriteConflicts(parsed.subtasks, {
              serializeMissingFiles: dagCfg.serializeMissingFiles,
            });
            if (edgesInserted.length > 0 && this.verbose) {
              console.log(
                `${C.BLUE}[Orchestrator] Injected ${edgesInserted.length} write-conflict edge(s).${C.RESET}`,
              );
              for (const e of edgesInserted) {
                console.log(
                  `  ${C.DIM}${e.from} → ${e.to}: ${e.reason}${C.RESET}`,
                );
              }
            }
            // Re-validate to confirm acyclicity (insertion is by sorted
            // id so a cycle is impossible, but we run validation again
            // for defense in depth).
            this.validateAndSortDAG(parsed.subtasks);
          }
          return parsed;
        }
        feedback = "Missing subtasks array";
      } catch (err: any) {
        feedback = err.message || String(err);
      }
      attempt++;
    }

    console.warn(
      `${C.YELLOW}[Orchestrator] Warning: Failed to generate plan. Falling back to SingleAgent execution...${C.RESET}`,
    );
    return {
      subtasks: [
        {
          id: "fallback-task",
          title: "Execute coding task",
          description: context.task,
          persona: "code",
          dependencies: [],
          files: [],
          status: "pending",
        },
      ],
    };
  }

  validateAndSortDAG(subtasks: Subtask[]): Subtask[] {
    const sorted: Subtask[] = [];
    const visited = new Set<string>();
    const temp = new Set<string>();
    const subtaskMap = new Map<string, Subtask>();

    for (const s of subtasks) {
      subtaskMap.set(s.id, s);
    }

    function visit(id: string) {
      if (temp.has(id)) {
        throw new Error(`Circular dependency detected at subtask: ${id}`);
      }
      if (!visited.has(id)) {
        temp.add(id);
        const subtask = subtaskMap.get(id);
        if (!subtask) {
          throw new Error(`Dependency subtask not found: ${id}`);
        }
        for (const depId of subtask.dependencies) {
          visit(depId);
        }
        temp.delete(id);
        visited.add(id);
        sorted.push(subtask);
      }
    }

    for (const s of subtasks) {
      visit(s.id);
    }

    return sorted;
  }
}
