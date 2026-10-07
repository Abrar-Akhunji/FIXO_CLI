import { colors } from "../colors.js";
import { type CommandHandler, type CommandContext } from "./types.js";

/**
 * Estimates API cost in USD based on model family and prompt/completion tokens.
 */
function estimateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const m = model.toLowerCase();
  let inputRatePerM = 3.0; // standard default ($3 / 1M input)
  let outputRatePerM = 15.0; // standard default ($15 / 1M output)

  if (
    m.includes("haiku") ||
    m.includes("flash") ||
    m.includes("mini") ||
    m.includes("deepseek") ||
    m.includes("llama-3-8b") ||
    m.includes("gemini-1.5-flash") ||
    m.includes("gemini-2.5-flash")
  ) {
    inputRatePerM = 0.35;
    outputRatePerM = 1.40;
  } else if (m.includes("gpt-4o") || m.includes("sonnet")) {
    inputRatePerM = 3.0;
    outputRatePerM = 15.0;
  } else if (m.includes("opus") || m.includes("o1") || m.includes("o3")) {
    inputRatePerM = 15.0;
    outputRatePerM = 60.0;
  } else if (m.includes("grok")) {
    inputRatePerM = 2.0;
    outputRatePerM = 10.0;
  }

  return (
    (promptTokens * inputRatePerM + completionTokens * outputRatePerM) /
    1_000_000
  );
}

export const usageCommand: CommandHandler = async (ctx: CommandContext) => {
  const stats = ctx.state.stats;
  const currentModel = ctx.state.currentModel || "auto";
  const conversationTokens = ctx.conversation.getTotalTokens();
  const promptTokens = stats.totalPromptTokens;
  const completionTokens = stats.totalCompletionTokens;
  const totalTokens = promptTokens + completionTokens;
  const estimatedUsd = estimateCost(currentModel, promptTokens, completionTokens);

  console.log(`\n${colors.bold}Session Token Usage & Cost Analytics:${colors.reset}`);
  console.log(`  ${colors.dim}Model:${colors.reset}               ${colors.cyan}${currentModel}${colors.reset}`);
  console.log(`  ${colors.dim}Total Prompts/Turns:${colors.reset} ${stats.totalTasks}`);
  console.log(`  ${colors.dim}Tool Executions:${colors.reset}     ${stats.totalToolCalls}`);
  console.log(`  ${colors.dim}Prompt Tokens:${colors.reset}       ${promptTokens.toLocaleString()}`);
  console.log(`  ${colors.dim}Completion Tokens:${colors.reset}   ${completionTokens.toLocaleString()}`);
  console.log(
    `  ${colors.dim}Total Session Tokens:${colors.reset}${colors.bold} ${totalTokens.toLocaleString()}${colors.reset}`,
  );
  console.log(
    `  ${colors.dim}Active History Tokens:${colors.reset}${conversationTokens.toLocaleString()}`,
  );
  console.log(
    `  ${colors.dim}Estimated Cost (USD):${colors.reset} ${colors.green}\$${estimatedUsd.toFixed(4)}${colors.reset}`,
  );

  if (stats.totalDurationMs > 0) {
    const sec = Math.round(stats.totalDurationMs / 1000);
    console.log(`  ${colors.dim}Total Compute Time:${colors.reset}  ${sec}s`);
  }
};

export const contextWindowCommand: CommandHandler = async (
  ctx: CommandContext,
) => {
  const limit = ctx.conversation.getContextLimit();
  const used = ctx.conversation.getTotalTokens();
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const remaining = Math.max(0, limit - used);

  const meterWidth = 30;
  const filledChars = Math.min(
    meterWidth,
    Math.round((percent / 100) * meterWidth),
  );
  const emptyChars = meterWidth - filledChars;

  let colorCode = colors.green;
  if (percent >= 80) {
    colorCode = colors.red;
  } else if (percent >= 60) {
    colorCode = colors.yellow;
  }

  const meter = `${colorCode}${"█".repeat(filledChars)}${colors.dim}${"░".repeat(emptyChars)}${colors.reset}`;

  console.log(`\n${colors.bold}Context Window Utilization:${colors.reset}`);
  console.log(`  Model: ${colors.cyan}${ctx.state.currentModel || "auto"}${colors.reset}`);
  console.log(`  Usage: [${meter}] ${colorCode}${percent}%${colors.reset}`);
  console.log(
    `  Tokens: ${used.toLocaleString()} used / ${limit.toLocaleString()} limit (${colors.cyan}${remaining.toLocaleString()}${colors.reset} remaining)`,
  );

  const history = ctx.conversation.getMessages();
  const systemTokens = ctx.conversation.getLastSystemTokens() || 1500;
  const summary = ctx.conversation.getSummary();
  const summaryTokens = summary
    ? ctx.conversation.estimateTokens(summary)
    : 0;

  console.log(`\n${colors.bold}Context Breakdown:${colors.reset}`);
  console.log(`  - System & instructions: ~${systemTokens.toLocaleString()} tokens`);
  if (summaryTokens > 0) {
    console.log(`  - Compacted summary:     ~${summaryTokens.toLocaleString()} tokens`);
  }
  console.log(
    `  - Conversation history:  ${history.length} messages (~${Math.max(0, used - systemTokens - summaryTokens).toLocaleString()} tokens)`,
  );
};
