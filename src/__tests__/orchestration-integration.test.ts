import { test } from "node:test";
import * as assert from "node:assert";
import fs from "node:fs";
import { AgentPool } from "../agent/agent-pool.js";
import { Orchestrator } from "../agent/orchestrator.js";
import type { TaskDAG, Subtask, AgentContext } from "../types.js";

test("Orchestrator and AgentPool Integration", async (t) => {
  const originalFetch = global.fetch;
  const originalReadFileSync = fs.readFileSync;
  (fs as any).readFileSync = (path: any, options: any) => {
    if (typeof path === "string" && path.includes("config.json")) {
      return JSON.stringify({ provider_mode: "proxy" });
    }
    return originalReadFileSync(path, options);
  };

  t.after(() => {
    (fs as any).readFileSync = originalReadFileSync;
  });

  await t.test("Orchestrator plan method parses subtasks", async () => {
    global.fetch = async (url, options) => {
      const mockPlan = {
        subtasks: [
          {
            id: "task_1",
            title: "Write code",
            description: "Implement functionality",
            persona: "code",
            dependencies: [],
            files: ["src/app.ts"],
          },
        ],
      };
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: { role: "assistant", content: JSON.stringify(mockPlan) },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
        { status: 200 },
      );
    };

    try {
      const orchestrator = new Orchestrator();
      const context: AgentContext = {
        task: "implement dynamic layout",
        model: "auto",
        cwd: ".",
        verbose: false,
        selectedFiles: [],
        mode: "BUILD",
      };
      const dag = await orchestrator.plan(context);
      if (dag.subtasks[0]?.id === "fallback-task") {
        // Orchestrator failed, falling back
      }
      assert.equal(dag.subtasks.length, 1);
      assert.equal(dag.subtasks[0].id, "task_1");
      assert.equal(dag.subtasks[0].persona, "code");
    } finally {
      global.fetch = originalFetch;
    }
  });

  await t.test(
    "Orchestrator plan method retries on non-conforming output",
    async () => {
      let callCount = 0;
      global.fetch = async (url, options) => {
        callCount++;
        const mockPlan = {
          subtasks: [
            {
              id: "task_1",
              title: "Write code",
              description: "Implement functionality",
              persona: "code",
              dependencies: [],
              files: ["src/app.ts"],
            },
          ],
        };

        let content = JSON.stringify(mockPlan);
        // On the first call, wrap it in a lot of conversational text
        if (callCount === 1) {
          content =
            "Here is the plan for Emergant. As you can see, I have carefully designed it.\n" +
            content +
            "\n<ask_human_response>I will assume defaults</ask_human_response>";
        }

        return new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content } }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 20,
              total_tokens: 30,
            },
          }),
          { status: 200 },
        );
      };

      try {
        const orchestrator = new Orchestrator();
        const context: AgentContext = {
          task: "implement dynamic layout",
          model: "auto",
          cwd: ".",
          verbose: false,
          selectedFiles: [],
          mode: "BUILD",
        };
        const dag = await orchestrator.plan(context);
        assert.equal(dag.subtasks.length, 1);
        assert.equal(
          callCount,
          2,
          "Should have retried once due to conversational text",
        );
      } finally {
        global.fetch = originalFetch;
      }
    },
  );

  await t.test("AgentPool reviewer feedback loop depth limit", async () => {
    // We want to verify that when a reviewer subtask has depth >= 3, it stops adding repair tasks.
    const pool = new AgentPool(3, 10);

    // Mock the worker to simulate reviewer returning non-approved
    (pool as any).worker = {
      run: async (context: any, task: any, subtaskBudget: number) => {
        return {
          success: true,
          output: "REJECTED: Code is bad.",
          tokensUsed: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
          },
          toolCallCount: 1,
        };
      },
    };

    // Construct a subtask list representing the 3rd depth of review
    const dag: TaskDAG = {
      subtasks: [
        {
          id: "review-review-review-task_1",
          title: "Deep reviewer task",
          description: "Check deep requirements",
          persona: "reviewer",
          dependencies: [],
          files: [],
          status: "pending",
          attemptCount: 3,
        },
      ],
    };

    const context: AgentContext = {
      task: "perform deep checks",
      model: "auto",
      cwd: ".",
      verbose: false,
      selectedFiles: [],
      mode: "BUILD",
    };

    const success = await pool.execute(context, dag);

    // It should complete successfully (by warning and stopping rather than infinite looping or failing)
    assert.equal(success, true);

    // Check that we did not add more subtasks because depth matches/exceeds 3
    assert.equal(dag.subtasks.length, 1);
  });
});
