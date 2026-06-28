import { test } from "node:test";
import * as assert from "node:assert";
import { SingleAgent, promptsWrapper } from "../agent/single-agent.js";
import { WorkerAgent } from "../agent/worker-agent.js";

test("Sprint 3 UX Polish Tests", async (t) => {
  await t.test(
    "SingleAgent askPermission allowWithoutPrompt and allowAll flags",
    async () => {
      const agent = new SingleAgent();
      // 1. allowWithoutPrompt should bypass
      const res1 = await (agent as any).askPermission(
        "write_file",
        { path: "test.txt" },
        "/tmp",
        undefined,
        true,
      );
      assert.equal(res1, true);

      // 2. allowAll should bypass
      (agent as any).allowAll = true;
      const res2 = await (agent as any).askPermission(
        "write_file",
        { path: "test.txt" },
        "/tmp",
      );
      assert.equal(res2, true);
    },
  );

  await t.test(
    'SingleAgent askPermission "Yes to all" sets allowAll to true',
    async () => {
      const agent = new SingleAgent();
      const originalSelect = promptsWrapper.select;
      let selectCalledWith: any = null;
      (promptsWrapper as any).select = async (options: any) => {
        selectCalledWith = options;
        return "all";
      };

      try {
        const res = await (agent as any).askPermission(
          "write_file",
          { path: "test.txt" },
          "/tmp",
        );
        assert.equal(res, true);
        assert.equal((agent as any).allowAll, true);
        assert.ok(selectCalledWith.message.includes("test.txt"));
      } finally {
        promptsWrapper.select = originalSelect;
      }
    },
  );

  await t.test(
    "WorkerAgent askPermission allowWithoutPrompt and allowAll flags",
    async () => {
      const worker = new WorkerAgent();
      // 1. context.yes should bypass
      const res1 = await (worker as any).askPermission(
        "write_file",
        { path: "test.txt" },
        undefined,
        { yes: true },
      );
      assert.equal(res1, true);

      // 2. allowAll should bypass
      (worker as any).allowAll = true;
      const res2 = await (worker as any).askPermission("write_file", {
        path: "test.txt",
      });
      assert.equal(res2, true);
    },
  );

  await t.test(
    'WorkerAgent askPermission "all" input sets allowAll to true',
    async () => {
      const worker = new WorkerAgent();
      let questionCalledWithPrompt = "";
      let questionCallback: any = null;
      const mockRl = {
        question: (prompt: string, callback: any) => {
          questionCalledWithPrompt = prompt;
          questionCallback = callback;
        },
      };

      const promise = (worker as any).askPermission(
        "write_file",
        { path: "test.txt" },
        mockRl as any,
      );

      // Simulate typing 'all'
      questionCallback("all");

      const res = await promise;
      assert.equal(res, true);
      assert.equal((worker as any).allowAll, true);
      assert.ok(questionCalledWithPrompt.includes("test.txt"));
    },
  );
});
