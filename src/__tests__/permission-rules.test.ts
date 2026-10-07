import { test } from "node:test";
import * as assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkPermission, resolveScopedDecision } from "../agent/permissions.js";
import { executeRunCommand } from "../agent/tool-executor.js";
import { getBackgroundJobRegistry } from "../agent/tool-executor.js";
import { SingleAgent } from "../agent/single-agent.js";
import { ConversationManager } from "../agent/conversation.js";
import type { AgentContext } from "../types.js";

test("deny wins over allow for the same command prefix", () => {
  const decision = resolveScopedDecision(
    [
      { pattern: "npm", decision: "allow" },
      { pattern: "npm publish", decision: "deny" },
    ],
    "npm publish --access public",
  );
  assert.equal(decision, "deny");

  const allow = resolveScopedDecision(
    [{ pattern: "git status", decision: "allow" }],
    "git status --short",
  );
  assert.equal(allow, "allow");

  const unrelated = resolveScopedDecision(
    [{ pattern: "git", decision: "deny" }],
    "npm test",
  );
  assert.equal(unrelated, null);
});

test("a deny rule blocks a command even when the caller would allow it", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-perm-"));
  const result = checkPermission(
    "run_command",
    { command: "npm publish" },
    cwd,
    "shell-confirm",
    {
      bash: [
        { pattern: "npm", decision: "allow" },
        { pattern: "npm publish", decision: "deny" },
      ],
      edit: [],
    },
  );
  assert.equal(result.decision, "deny");
  assert.match(result.reason, /denied by permission rule/);
});

test("yes does not override a deny rule inside the agent", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-perm-agent-"));
  const agent = new SingleAgent();
  const conversation = new ConversationManager();
  let turns = 0;
  let seenToolResult = "";
  (agent as any).client = {
    chat: async (messages: Array<{ role?: string; content?: string }>) => {
      turns += 1;
      if (turns > 1) {
        const tool = messages.find((message) => message.role === "tool");
        seenToolResult = String(tool?.content ?? "");
        return {
          content: "stopped",
          tool_calls: [],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          model: "test-model",
        };
      }
      return {
        content: "publishing",
        tool_calls: [
          {
            id: "call_pub",
            type: "function",
            function: {
              name: "run_command",
              arguments: JSON.stringify({ command: "npm publish" }),
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        model: "test-model",
      };
    },
  };

  const context: AgentContext = {
    task: "Publish the package",
    model: "auto",
    cwd,
    verbose: false,
    selectedFiles: [],
    mode: "BUILD",
    yes: true,
    maxTurns: 2,
    permissionRules: {
      bash: [{ pattern: "npm publish", decision: "deny" }],
    },
  };
  const result = await agent.runStreaming(context, conversation);
  assert.equal(result.success, true);
  assert.match(seenToolResult, /denied by permission rule/);
});

test("a foreground command that outlives the wait moves to the background", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-bg-"));
  const output = await executeRunCommand("sleep 5", cwd, cwd, undefined, undefined, 150);
  assert.match(output, /Command moved to background as job_/);
  const match = output.match(/job_[a-z0-9]+/);
  assert.ok(match);
  const registry = getBackgroundJobRegistry(cwd);
  const killed = registry.kill(match[0]);
  assert.equal(killed.ok, true);
});
