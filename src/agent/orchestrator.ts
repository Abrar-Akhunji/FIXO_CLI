import type { AgentContext, Subtask, TaskDAG } from '../types.js';
import { AgentClient } from './agent-client.js';
import { loadConfig } from '../config.js';
import { C } from '../ui/colors.js';

export class Orchestrator {
  private client: AgentClient;
  private verbose: boolean;
  public tokensUsed = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  constructor(verbose = false) {
    const config = loadConfig();
    this.client = new AgentClient(config.freellmapi_api_key || '', config.apiUrl, verbose);
    this.verbose = verbose;
  }

  async plan(context: AgentContext): Promise<TaskDAG> {
    const systemPrompt = `You are the FixO Orchestrator. Your job is to analyze a complex software engineering task and decompose it into a Directed Acyclic Graph (DAG) of subtasks.
Each subtask will be assigned to a specialist worker agent:
- 'code': Writes or modifies code files.
- 'test': Creates, updates, or executes test suites.
- 'doc': Updates documentation, READMEs, JSDocs, etc.
- 'reviewer': Reviews changes, audits code modifications.

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
    let feedback = '';

    while (attempt < maxRetries) {
      if (attempt > 0) {
        const delayMs = Math.pow(2, attempt) * 1000;
        if (this.verbose) {
          console.log(`[Orchestrator] Retrying plan generation in ${(delayMs / 1000).toFixed(1)}s...`);
        }
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
      try {
        const response = await this.client.chat(
          [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: context.task + (feedback ? `\n\nPrevious attempt failed validation: ${feedback}. Please output only valid JSON matching the schema.` : '') }
          ],
          context.model,
          { agent_task_type: 'investigation', required_capabilities: ['fast'] }
        );

        if (response.usage) {
          this.tokensUsed.prompt_tokens += response.usage.prompt_tokens;
          this.tokensUsed.completion_tokens += response.usage.completion_tokens;
          this.tokensUsed.total_tokens += response.usage.total_tokens;
        }

        const content = response.content?.trim() || '';
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content) as TaskDAG;

        if (parsed && Array.isArray(parsed.subtasks)) {
          this.validateAndSortDAG(parsed.subtasks);
          return parsed;
        }
        feedback = 'Missing subtasks array';
      } catch (err: any) {
        feedback = err.message || String(err);
      }
      attempt++;
    }

    console.warn(`${C.YELLOW}[Orchestrator] Warning: Failed to generate plan. Falling back to SingleAgent execution...${C.RESET}`);
    return {
      subtasks: [
        {
          id: 'fallback-task',
          title: 'Execute coding task',
          description: context.task,
          persona: 'code',
          dependencies: [],
          files: [],
          status: 'pending'
        }
      ]
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
