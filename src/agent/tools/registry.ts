import type {
  ToolDispatchResult,
  ToolExecutionContext,
  ToolSpecification,
} from "./types.js";

/**
 * Process-global registry of typed tool specifications.
 * New tools register themselves here; the existing `TOOL_DEFINITIONS` array
 * remains the LLM-facing JSON-Schema surface.
 */
const toolRegistry = new Map<
  string,
  ToolSpecification<Record<string, any>, string>
>();

/** Register a typed tool specification. Throws on duplicate. */
export function registerTool<
  TArgs extends Record<string, any>,
  TResult = string,
>(spec: ToolSpecification<TArgs, TResult>): void {
  if (toolRegistry.has(spec.name)) {
    throw new Error(`Tool "${spec.name}" is already registered.`);
  }
  toolRegistry.set(
    spec.name,
    spec as unknown as ToolSpecification<Record<string, any>, string>,
  );
}

/** Look up a registered tool specification. */
export function getToolSpecification(
  name: string,
): ToolSpecification<Record<string, any>, string> | undefined {
  return toolRegistry.get(name);
}

/** List the names of all registered typed tools. */
export function listRegisteredToolNames(): string[] {
  return Array.from(toolRegistry.keys()).sort();
}

/** Run a tool that registered itself. Unknown names return null. */
export async function runRegisteredTool(
  name: string,
  args: Record<string, string>,
  ctx: ToolExecutionContext,
): Promise<ToolDispatchResult | null> {
  const spec = getToolSpecification(name);
  if (!spec) return null;
  const raw = await spec.execute(args, ctx);
  if (raw && typeof raw === "object" && "result" in raw) {
    return raw;
  }
  return { result: String(raw ?? "") };
}
