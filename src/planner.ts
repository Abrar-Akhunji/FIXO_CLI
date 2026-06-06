import fs from 'fs';
import path from 'path';

/* ──────────────────────── Loop-Trap Detector Re-Exports ─────────────────── */

/**
 * Re-exported here so external callers (e.g. `SingleAgent`,
 * telemetry sinks) can import the entire loop-trap surface from
 * `src/planner.ts` without taking a hard dependency on the
 * `src/runtime/` directory layout. The implementation lives in
 * `src/runtime/loop-trap.ts`; this file is the public façade.
 */
export {
  LoopTrapDetector,
  LoopTrapAbortedError,
  DEFAULT_LOOP_TRAP_PREFS,
  canonicaliseArgs,
} from './runtime/loop-trap.js';

export type {
  LoopSnapshot,
  LoopTrapVerdict,
  LoopTrapLayer,
  LoopTrapPreferences,
} from './runtime/loop-trap.js';

export interface SavedPlan {
  task: string;
  createdAt: string;
  taskType: 'chat' | 'review' | 'mutation' | 'test-fix' | 'refactor' | 'investigation';
  expectedFiles: string[];
  verificationCommand: string | null;
  stages: string[];
}

const DEFAULT_STAGES = [
  'Understand: inspect indexed context and relevant files before editing.',
  'Plan: choose patch-based edits and expected verification command.',
  'Act: apply minimal workspace-scoped changes through guarded tools.',
  'Verify: run detected checks or configured checkCommand.',
  'Summarize: report changed files, checks, and residual risk.',
];

export function createStructuredPlan(task: string): SavedPlan {
  const lower = task.toLowerCase();
  const taskType: SavedPlan['taskType'] =
    lower.includes('review') ? 'review'
      : lower.includes('test') || lower.includes('failing') ? 'test-fix'
        : lower.includes('refactor') ? 'refactor'
          : /explain|what|why|how|list|show/.test(lower) ? 'investigation'
            : /^(hi|hello|hey|thanks|thank you|ok|bye)\b/.test(lower) ? 'chat'
              : 'mutation';
  const extensions = '(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|css|scss|json|md|yml|yaml|toml|sh|bash|txt|html|vue|svelte)';
  const expectedFiles = Array.from(task.matchAll(new RegExp(`\\b([\\w./-]+\\.${extensions})\\b`, 'gi'))).map(match => match[1]);
  const verificationCommand = taskType === 'chat' || taskType === 'investigation' || taskType === 'review'
    ? null
    : 'auto-detect';
  return {
    task,
    taskType,
    expectedFiles,
    verificationCommand,
    createdAt: new Date().toISOString(),
    stages: DEFAULT_STAGES,
  };
}

export function validatePlan(plan: unknown): plan is SavedPlan {
  if (!plan || typeof plan !== 'object') return false;
  const p = plan as SavedPlan;
  return typeof p.task === 'string'
    && typeof p.createdAt === 'string'
    && ['chat', 'review', 'mutation', 'test-fix', 'refactor', 'investigation'].includes(p.taskType)
    && Array.isArray(p.expectedFiles)
    && (typeof p.verificationCommand === 'string' || p.verificationCommand === null)
    && Array.isArray(p.stages);
}

export function savePlan(cwd: string, task: string): SavedPlan {
  const plan = createStructuredPlan(task);
  const dir = path.join(cwd, '.fixo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'last-plan.json'), JSON.stringify(plan, null, 2) + '\n', 'utf-8');
  return plan;
}

export function loadPlan(cwd: string): SavedPlan | null {
  const file = path.join(cwd, '.fixo', 'last-plan.json');
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
  return validatePlan(parsed) ? parsed : null;
}

export function renderPlan(plan: SavedPlan): string {
  return [
    `Task: ${plan.task}`,
    `Type: ${plan.taskType}`,
    `Created: ${plan.createdAt}`,
    `Expected files: ${plan.expectedFiles.join(', ') || '(none)'}`,
    `Verification: ${plan.verificationCommand ?? '(none)'}`,
    ...plan.stages.map((stage, index) => `${index + 1}. ${stage}`),
  ].join('\n');
}

/* ──────────────────────── Trivial Query Detection ──────────────────────── */

export const TRIVIAL_PATTERNS = [
  /^(hi|hey|hello|howdy|yo|sup|greetings|hola|namaste)/i,
  /^(thanks|thank you|thx|ty|cheers)/i,
  /^(what can you do|who are you|help me|how does this work)/i,
  /^(good morning|good evening|good night|gm|gn)/i,
  /^(ok|okay|sure|great|nice|cool|awesome|perfect|got it)/i,
  /^(bye|goodbye|see you|later|exit|quit)/i,
];

export function isTrivialQuery(input: string): boolean {
  const trimmed = input.trim();
  if (trimmed.length < 3) return true;
  if (trimmed.length > 100) return false; // Long inputs are usually tasks

  for (const pattern of TRIVIAL_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }

  return false;
}

/* ──────────────────────── Complexity Classification ──────────────────────── */

export interface ComplexityClassification {
  complexity: 'simple' | 'complex';
  reason: string;
}

export function classifyComplexityHeuristic(task: string): ComplexityClassification {
  const trimmed = task.trim();
  if (isTrivialQuery(trimmed)) {
    return { complexity: 'simple', reason: 'Trivial chat query' };
  }

  const plan = createStructuredPlan(trimmed);
  if (plan.taskType === 'chat' || plan.taskType === 'investigation' || plan.taskType === 'review') {
    return { complexity: 'simple', reason: `Task type is ${plan.taskType}` };
  }

  // Check expected files.
  if (plan.expectedFiles.length > 1) {
    return { complexity: 'complex', reason: `Affects multiple files: ${plan.expectedFiles.join(', ')}` };
  }

  // Keywords that hint at complex operations
  const complexKeywords = [
    'system-wide', 'across the codebase', 'all files', 'every file', 'refactor the entire',
    'multiple modules', 'architecture', 'orchestration', 'parallel', 'concurrent'
  ];
  const lower = trimmed.toLowerCase();
  for (const kw of complexKeywords) {
    if (lower.includes(kw)) {
      return { complexity: 'complex', reason: `Contains complexity keyword: "${kw}"` };
    }
  }

  // Simple edits / single file modifications are default simple
  return { complexity: 'simple', reason: 'Single-file or narrow mutation scope' };
}

import type { AgentClient } from './agent/agent-client.js';

export async function classifyComplexityModel(
  task: string,
  model: string,
  client: AgentClient
): Promise<ComplexityClassification> {
  const heuristic = classifyComplexityHeuristic(task);
  // If heuristic is already complex, or if it is trivially simple, return it to save latency/tokens.
  if (heuristic.complexity === 'complex' || heuristic.reason.startsWith('Trivial')) {
    return heuristic;
  }

  const systemPrompt = `You are the FixO Complexity Classifier. Your job is to classify if a software engineering task is SIMPLE or COMPLEX.

CRITERIA:
- SIMPLE: Questions, explanations, conceptual reviews, single-file mutations (e.g. adding a field, fixing a minor bug, writing a test for a single file), or basic script creation.
- COMPLEX: Multi-file changes, large refactoring, integration changes across layers (e.g. modifying both frontend and backend, changing API contracts between multiple files), or anything requiring parallel execution of subtasks.

Output ONLY a JSON object:
{
  "complexity": "simple" | "complex",
  "reason": "short explanation of the decision"
}
NO markdown formatting, NO backticks, and NO conversational text.`;

  try {
    const response = await client.chat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: task }
      ],
      model,
      { agent_task_type: 'investigation', required_capabilities: ['fast'] }
    );
    const content = response.content?.trim() || '';
    // Clean JSON from potential markdown blocks
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content);
    if (parsed && (parsed.complexity === 'simple' || parsed.complexity === 'complex')) {
      return {
        complexity: parsed.complexity,
        reason: parsed.reason || 'Model classification'
      };
    }
  } catch (err) {
    // Fallback to heuristic
  }

  return heuristic;
}

