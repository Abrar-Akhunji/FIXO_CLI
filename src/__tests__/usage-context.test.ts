import { test } from "node:test";
import assert from "node:assert/strict";
import { usageCommand, contextWindowCommand } from "../ui/commands/usage-commands.js";

test("usageCommand executes and prints token and cost breakdowns", async () => {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: any[]) => {
    logs.push(args.map(String).join(" "));
  };

  try {
    const ctx: any = {
      args: [],
      state: {
        currentModel: "gpt-4o",
        stats: {
          totalPromptTokens: 10_000,
          totalCompletionTokens: 2_000,
          totalToolCalls: 5,
          totalTasks: 3,
          totalDurationMs: 4_500,
        },
      },
      conversation: {
        getTotalTokens: () => 12_000,
      },
    };

    await usageCommand(ctx);
    const output = logs.join("\n");
    assert.ok(output.includes("Session Token Usage & Cost Analytics"));
    assert.ok(output.includes("gpt-4o"));
    assert.ok(output.includes("10,000"));
    assert.ok(output.includes("2,000"));
    assert.ok(output.includes("Estimated Cost (USD)"));
  } finally {
    console.log = origLog;
  }
});

test("contextWindowCommand executes and prints utilization bar and breakdown", async () => {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: any[]) => {
    logs.push(args.map(String).join(" "));
  };

  try {
    const ctx: any = {
      args: [],
      state: {
        currentModel: "claude-3-5-sonnet",
      },
      conversation: {
        getContextLimit: () => 100_000,
        getTotalTokens: () => 25_000,
        getLastSystemTokens: () => 2_000,
        getSummary: () => "Previous goal and constraints",
        estimateTokens: () => 500,
        getMessages: () => [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }],
      },
    };

    await contextWindowCommand(ctx);
    const output = logs.join("\n");
    assert.ok(output.includes("Context Window Utilization"));
    assert.ok(output.includes("25%"));
    assert.ok(output.includes("25,000 used / 100,000 limit"));
    assert.ok(output.includes("75,000"));
    assert.ok(output.includes("remaining"));
    assert.ok(output.includes("Context Breakdown"));
    assert.ok(output.includes("System & instructions"));
  } finally {
    console.log = origLog;
  }
});
