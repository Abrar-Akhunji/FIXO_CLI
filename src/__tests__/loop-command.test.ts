import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseInterval,
  loopCommand,
  getActiveLoops,
  stopAllLoops,
} from "../ui/commands/loop-command.js";
import type { CommandContext } from "../ui/commands/types.js";

test("parseInterval parses seconds, minutes, hours, and bare numbers", () => {
  assert.equal(parseInterval("10s"), 10_000);
  assert.equal(parseInterval("45sec"), 45_000);
  assert.equal(parseInterval("60seconds"), 60_000);

  assert.equal(parseInterval("1m"), 60_000);
  assert.equal(parseInterval("2.5min"), 150_000);
  assert.equal(parseInterval("5minutes"), 300_000);

  assert.equal(parseInterval("1h"), 3_600_000);
  assert.equal(parseInterval("2hours"), 7_200_000);

  assert.equal(parseInterval("30"), 30_000);

  assert.equal(parseInterval(""), null);
  assert.equal(parseInterval("invalid"), null);
  assert.equal(parseInterval("-5s"), null);
  assert.equal(parseInterval("0s"), null);
});

test("loopCommand lifecycle (start, list, stop, stop all)", async () => {
  stopAllLoops();
  const handleCalls: string[] = [];
  const makeCtx = (args: string[]): CommandContext => {
    return {
      args,
      state: {
        isTaskRunning: false,
        currentModel: "auto",
      } as any,
      handleInput: async (prompt: string) => {
        handleCalls.push(prompt);
      },
    } as any;
  };

  // Help
  await loopCommand(makeCtx([]));
  assert.equal(getActiveLoops().length, 0);

  // Reject < 5s
  await loopCommand(makeCtx(["2s", "test", "cmd"]));
  assert.equal(getActiveLoops().length, 0);

  // Start loop 1
  await loopCommand(makeCtx(["10s", "check", "system"]));
  const active = getActiveLoops();
  assert.equal(active.length, 1);
  assert.equal(active[0].intervalMs, 10_000);
  assert.equal(active[0].prompt, "check system");

  const loopId = active[0].id;

  // List loops
  await loopCommand(makeCtx(["list"]));

  // Stop single loop
  await loopCommand(makeCtx(["stop", loopId]));
  assert.equal(getActiveLoops().length, 0);

  // Start two loops and stop all
  await loopCommand(makeCtx(["10s", "task 1"]));
  await loopCommand(makeCtx(["20s", "task 2"]));
  assert.equal(getActiveLoops().length, 2);

  await loopCommand(makeCtx(["stop", "all"]));
  assert.equal(getActiveLoops().length, 0);
  stopAllLoops();
});
