import { test } from "node:test";
import * as assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SingleAgent, buildSystemPrompt } from "../agent/single-agent.js";
import { ConversationManager } from "../agent/conversation.js";
import { executeTool } from "../agent/tool-executor.js";
import { planModeBlock, planModeError } from "../agent/plan-gate.js";
import { answerAskUserQuestion } from "../agent/ask-user.js";
import { capSkillPrompt, SKILL_PROMPT_CAP } from "../agent/skills.js";
import {
  headlessExitCode,
  headlessStatusLine,
} from "../runtime/headless-contract.js";
import type { AgentContext } from "../types.js";

test("capSkillPrompt keeps the 8000 character ceiling", () => {
  const huge = "x".repeat(SKILL_PROMPT_CAP + 500);
  const capped = capSkillPrompt(huge);
  assert.ok(capped.length < huge.length);
  assert.ok(capped.includes("truncated to 8000 characters"));
  assert.ok(capped.startsWith("x".repeat(100)));
  assert.ok(capped.length <= SKILL_PROMPT_CAP + 80);
});

test("buildSystemPrompt includes a named skill and stays capped", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-skill-prompt-"));
  const skillDir = path.join(cwd, ".fixocli", "skills", "widget");
  fs.mkdirSync(skillDir, { recursive: true });
  const body = "WIDGET_RULE unique marker\n" + "y".repeat(SKILL_PROMPT_CAP + 200);
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\nname: widget\ndescription: widget rules\n---\n${body}\n`,
  );

  const prompt = buildSystemPrompt(
    "",
    {
      task: "please apply @widget",
      model: "auto",
      cwd,
      verbose: false,
      selectedFiles: [],
      mode: "BUILD",
    },
    true,
    "MUTATION",
    "BUILD",
  );
  assert.ok(prompt.includes("WIDGET_RULE unique marker"));
  assert.ok(prompt.includes("truncated to 8000 characters"));
  assert.ok(prompt.includes("**str_replace**"));
  assert.ok(prompt.includes("ask_user_question"));
});

test("ask_user_question without readline returns an error and does not hang", async () => {
  const result = await answerAskUserQuestion(
    { question: "Which stack?", options: ["a", "b"] },
    undefined,
  );
  assert.match(result, /^Error: This session cannot ask the user/);

  const event = await executeTool(
    "ask_user_question",
    { question: "Which stack?", options: "a,b" },
    process.cwd(),
    false,
    {},
  );
  assert.equal(event.ok, false);
  assert.match(event.result, /cannot ask the user/);
});

test("PLAN mode blocks writes and mutating shell, allows a read and the plan file", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-plan-gate-"));
  fs.mkdirSync(path.join(cwd, ".fixo"), { recursive: true });

  const write = await planModeBlock(
    "write_file",
    { path: "src/app.ts", content: "nope" },
    cwd,
  );
  assert.equal(write, planModeError("write_file"));

  const planWrite = await planModeBlock(
    "write_file",
    { path: ".fixo/last-plan.json", content: "{}" },
    cwd,
  );
  assert.equal(planWrite, null);

  const mutating = await planModeBlock(
    "run_command",
    { command: "rm src/app.ts" },
    cwd,
  );
  assert.equal(mutating, planModeError("run_command"));

  const reading = await planModeBlock(
    "run_command",
    { command: "ls" },
    cwd,
  );
  assert.equal(reading, null);

  const event = await executeTool(
    "delete_file",
    { path: "src/app.ts" },
    cwd,
    false,
    { mode: "PLAN" },
  );
  assert.equal(event.ok, false);
  assert.match(event.result, /blocked in PLAN mode/);
});

test("tool call limit is incomplete, not success", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-limit-"));
  const agent = new SingleAgent();
  const conversation = new ConversationManager();
  let calls = 0;
  (agent as any).client = {
    chat: async () => {
      calls += 1;
      return {
        content: "still working",
        tool_calls: [
          {
            id: `call_${calls}`,
            type: "function",
            function: {
              name: "list_dir",
              arguments: JSON.stringify({ path: "." }),
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        model: "test-model",
      };
    },
  };

  const context: AgentContext = {
    task: "Keep listing until the cap",
    model: "auto",
    cwd,
    verbose: false,
    selectedFiles: [],
    mode: "BUILD",
    yes: true,
    maxTurns: 1,
  };

  const result = await agent.runStreaming(context, conversation);
  assert.equal(result.success, false);
  assert.match(result.response, /incomplete: tool call limit reached/);
  assert.equal(headlessExitCode(result.success), 1);
  assert.equal(headlessStatusLine(result), result.response.split("\n")[0]);
  assert.equal(calls, 1);
});

test("a no-tool answer is done and exits 0", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-done-"));
  const agent = new SingleAgent();
  const conversation = new ConversationManager();
  (agent as any).client = {
    chat: async () => ({
      content: "The answer is 4.",
      tool_calls: [],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      model: "test-model",
    }),
  };
  const result = await agent.runStreaming(
    {
      task: "Add a short note",
      model: "auto",
      cwd,
      verbose: false,
      selectedFiles: [],
      mode: "BUILD",
      yes: true,
    },
    conversation,
  );
  assert.equal(result.success, true);
  assert.equal(headlessStatusLine(result), "done");
  assert.equal(headlessExitCode(result.success), 0);
});

test("verification still failing is incomplete", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-verify-fail-"));
  fs.writeFileSync(
    path.join(cwd, "package.json"),
    JSON.stringify({
      scripts: { test: "node -e \"process.exit(1)\"" },
    }),
  );
  const agent = new SingleAgent();
  const conversation = new ConversationManager();
  let calls = 0;
  (agent as any).client = {
    chat: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          content: "writing",
          tool_calls: [
            {
              id: "call_write",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({
                  path: "note.txt",
                  content: "changed",
                }),
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          model: "test-model",
        };
      }
      return {
        content: "I think it is fixed.",
        tool_calls: [],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        model: "test-model",
      };
    },
  };

  const context: AgentContext = {
    task: "Change note.txt",
    model: "auto",
    cwd,
    verbose: false,
    selectedFiles: [],
    mode: "BUILD",
    yes: true,
    checkCommand: "npm test",
  };

  const result = await agent.runStreaming(context, conversation);
  assert.equal(result.success, false);
  assert.match(result.response, /incomplete: verification failed/);
});
