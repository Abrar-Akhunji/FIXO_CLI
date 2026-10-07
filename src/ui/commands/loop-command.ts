import { colors } from "../colors.js";
import { type CommandHandler, type CommandContext } from "./types.js";

export interface ActiveLoop {
  id: string;
  intervalMs: number;
  intervalStr: string;
  prompt: string;
  runCount: number;
  createdAt: number;
  lastRunAt?: number;
  nextRunAt: number;
  timer: NodeJS.Timeout;
}

const activeLoops = new Map<string, ActiveLoop>();
let loopCounter = 1;

/**
 * Parses interval strings like "30s", "2m", "1h", or bare numbers (interpreted as seconds).
 * Returns duration in milliseconds, or null if invalid.
 */
export function parseInterval(input: string): number | null {
  if (!input) return null;
  const match = input.trim().match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?$/i);
  if (!match) return null;

  const value = parseFloat(match[1]);
  if (isNaN(value) || value <= 0) return null;

  const unit = (match[2] || "s").toLowerCase();
  if (unit.startsWith("s")) {
    return Math.round(value * 1000);
  }
  if (unit.startsWith("m")) {
    return Math.round(value * 60 * 1000);
  }
  if (unit.startsWith("h")) {
    return Math.round(value * 60 * 60 * 1000);
  }
  return Math.round(value * 1000);
}

export function getActiveLoops(): ActiveLoop[] {
  return Array.from(activeLoops.values());
}

export function stopLoop(id: string): boolean {
  const loop = activeLoops.get(id);
  if (!loop) return false;
  clearInterval(loop.timer);
  activeLoops.delete(id);
  return true;
}

export function stopAllLoops(): number {
  const count = activeLoops.size;
  for (const loop of activeLoops.values()) {
    clearInterval(loop.timer);
  }
  activeLoops.clear();
  return count;
}

export const loopCommand: CommandHandler = async (ctx: CommandContext) => {
  const sub = ctx.args[0];

  if (!sub || sub === "help") {
    console.log(`\n${colors.bold}Recurring Loop Commands (/loop):${colors.reset}`);
    console.log(
      `  ${colors.cyan}/loop <interval> <prompt>${colors.reset}   Start a recurring prompt execution`,
    );
    console.log(
      `  ${colors.cyan}/loop list${colors.reset}                  List all currently active recurring loops`,
    );
    console.log(
      `  ${colors.cyan}/loop stop <id|all>${colors.reset}         Stop a specific loop or terminate all loops`,
    );
    console.log(`\n${colors.dim}Examples:${colors.reset}`);
    console.log(`  /loop 30s npm test`);
    console.log(`  /loop 2m git status`);
    console.log(`  /loop 1h check security advisory`);
    return;
  }

  if (sub === "list") {
    if (activeLoops.size === 0) {
      console.log(`\n${colors.dim}No recurring loops currently active.${colors.reset}`);
      return;
    }
    console.log(`\n${colors.bold}Active Recurring Loops (${activeLoops.size}):${colors.reset}`);
    for (const loop of activeLoops.values()) {
      const remainingSec = Math.max(
        0,
        Math.round((loop.nextRunAt - Date.now()) / 1000),
      );
      console.log(
        `  ${colors.cyan}${loop.id}${colors.reset} [every ${loop.intervalStr}] runs: ${loop.runCount} (next in ${remainingSec}s): "${colors.bold}${loop.prompt}${colors.reset}"`,
      );
    }
    return;
  }

  if (sub === "stop") {
    const target = ctx.args[1];
    if (!target) {
      console.log(`\n${colors.yellow}Usage: /loop stop <id|all>${colors.reset}`);
      return;
    }
    if (target.toLowerCase() === "all") {
      const stopped = stopAllLoops();
      console.log(`\n${colors.green}✓ Stopped all active loops (${stopped} cancelled)${colors.reset}`);
      return;
    }
    const stopped = stopLoop(target);
    if (stopped) {
      console.log(`\n${colors.green}✓ Stopped recurring loop ${target}${colors.reset}`);
    } else {
      console.log(`\n${colors.red}✗ Loop '${target}' not found. Use /loop list to see active loops.${colors.reset}`);
    }
    return;
  }

  // Creating a new recurring loop: /loop <interval> <prompt>
  const intervalStr = sub;
  const prompt = ctx.args.slice(1).join(" ").trim();
  if (!prompt) {
    console.log(`\n${colors.yellow}Usage: /loop <interval> <prompt>${colors.reset}`);
    return;
  }

  const intervalMs = parseInterval(intervalStr);
  if (intervalMs === null) {
    console.log(
      `\n${colors.red}✗ Invalid interval: '${intervalStr}'. Examples: 30s, 2m, 1h.${colors.reset}`,
    );
    return;
  }

  const MIN_INTERVAL_MS = 5000;
  if (intervalMs < MIN_INTERVAL_MS) {
    console.log(
      `\n${colors.red}✗ Interval too short. Minimum allowed interval is 5 seconds.${colors.reset}`,
    );
    return;
  }

  const id = `loop-${loopCounter++}`;
  const loop: ActiveLoop = {
    id,
    intervalMs,
    intervalStr,
    prompt,
    runCount: 0,
    createdAt: Date.now(),
    nextRunAt: Date.now() + intervalMs,
    timer: setInterval(async () => {
      if (ctx.state.isTaskRunning) {
        // Skip or defer if a task is already executing in this session
        return;
      }
      loop.runCount++;
      loop.lastRunAt = Date.now();
      loop.nextRunAt = Date.now() + loop.intervalMs;

      process.stdout.write(
        `\n\n${colors.cyan}⏱ [Recurring Loop ${loop.id} #${loop.runCount}]${colors.reset} ${colors.bold}${loop.prompt}${colors.reset}\n`,
      );
      try {
        await ctx.handleInput(loop.prompt);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stdout.write(
          `\n${colors.red}✗ Loop execution error: ${msg}${colors.reset}\n`,
        );
      }
    }, intervalMs),
  };

  loop.timer.unref?.();
  activeLoops.set(id, loop);

  console.log(
    `\n${colors.green}✓ Started recurring loop [${id}] every ${intervalStr}:${colors.reset} "${colors.bold}${prompt}${colors.reset}"`,
  );
  console.log(`${colors.dim}  Use /loop list or /loop stop ${id} to manage.${colors.reset}`);
};
