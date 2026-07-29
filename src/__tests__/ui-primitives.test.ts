/**
 * ui-primitives.test.ts — Coverage for the lava-redesign
 * render primitives in `src/ui/render-primitives.ts`,
 * `src/ui/session-header.ts`, `src/ui/plan-renderer.ts`, and
 * `src/ui/ascii.ts`.
 *
 * The renderers all write to `process.stdout`; the tests
 * capture that output via a monkey-patched `process.stdout.write`
 * and assert on the captured string. The patch is restored in
 * the suite's `after` hook so a test failure can't leak the
 * stub into subsequent tests.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  C,
  visLen,
  padToVisual,
  providerColor,
  pill,
  lava,
  snow,
  dim,
  green,
  blue,
  yellow,
  purple,
  red,
  bold,
} from "../ui/colors.js";
import { getLavaLogo, getTagline, renderLogo } from "../ui/ascii.js";
import {
  renderStatusBar,
  renderProviderList,
  renderToolCall,
  renderRoutingBanner,
  renderAIResponse,
  renderCostLine,
  renderModeSelector,
  startInlineToolSpinner,
  type CLIState,
  type Provider,
  type ToolCallRender,
} from "../ui/render-primitives.js";
import { renderSessionHeader } from "../ui/session-header.js";
import { renderPlan, type PlanStep } from "../ui/plan-renderer.js";
import { COMMANDS_WITH_DESC } from "../ui/render.js";

/* ──────────────────────── stdout capture ──────────────────────── */

let captured = "";
const originalWrite = process.stdout.write.bind(process.stdout);

function captureStdout(): void {
  captured = "";
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (
    s: string,
  ) => {
    captured += s;
    return true;
  };
}

test.beforeEach(() => {
  captureStdout();
});
test.afterEach(() => {
  (process.stdout as unknown as { write: typeof originalWrite }).write =
    originalWrite;
});

/* ──────────────────────── Color helpers ──────────────────────── */

test("C palette exposes the canonical brand colours", () => {
  assert.equal(C.LAVA, "\x1b[38;2;245;110;15m");
  assert.equal(C.SNOW, "\x1b[38;2;251;251;251m");
  assert.equal(C.VOID, "\x1b[48;2;21;20;25m");
  assert.equal(C.RESET, "\x1b[0m");
});

test("lava/snow/dim/green/blue/yellow/purple/red/bold wrap with RESET", () => {
  assert.equal(lava("x"), `${C.LAVA}x${C.RESET}`);
  assert.equal(snow("x"), `${C.SNOW}x${C.RESET}`);
  assert.equal(dim("x"), `${C.SNOW4}x${C.RESET}`);
  assert.equal(green("x"), `${C.GREEN}x${C.RESET}`);
  assert.equal(blue("x"), `${C.BLUE}x${C.RESET}`);
  assert.equal(yellow("x"), `${C.YELLOW}x${C.RESET}`);
  assert.equal(purple("x"), `${C.PURPLE}x${C.RESET}`);
  assert.equal(red("x"), `${C.RED}x${C.RESET}`);
  assert.equal(bold("x"), `${C.BOLD}x${C.RESET}`);
});

test("visLen strips ANSI escapes before measuring", () => {
  const s = `${C.LAVA}hello${C.RESET} world`;
  assert.equal(visLen(s), 11);
  assert.equal(s.length, 11 + C.LAVA.length + C.RESET.length);
});

test("padToVisual pads by visible width, not byte width", () => {
  const s = `${C.LAVA}hi${C.RESET}`;
  assert.equal(visLen(padToVisual(s, 5)), 5);
});

test("pill formats as `${bg}${fg} ${text} ${RESET}`", () => {
  const p = pill("OK", C.GREEN, C.VOID3);
  assert.equal(p, `${C.VOID3}${C.GREEN} OK ${C.RESET}`);
});

test("providerColor maps common names to brand colours", () => {
  assert.equal(providerColor("Anthropic (Claude)"), C.P_ANTHROPIC);
  assert.equal(providerColor("Google (Gemini)"), C.P_GOOGLE);
  assert.equal(providerColor("Groq"), C.P_GROQ);
  assert.equal(providerColor("OpenAI"), C.P_OPENAI);
  assert.equal(providerColor("Zen (OpenCode)"), C.P_ZEN);
  assert.equal(providerColor("Mistral"), C.P_MISTRAL);
  assert.equal(providerColor("NVIDIA NIM"), C.P_NVIDIA);
  assert.equal(providerColor("Unknown Provider"), C.SNOW2);
});

/* ──────────────────────── Logo ──────────────────────── */

test("getLavaLogo returns 6 lines, each coloured in LAVA", () => {
  const lines = getLavaLogo().split("\n");
  assert.equal(lines.length, 6);
  for (const line of lines) {
    assert.ok(line.startsWith(C.LAVA));
    assert.ok(line.endsWith(C.RESET));
  }
});

test("getTagline includes version + 4 keywords in SNOW4", () => {
  const t = getTagline();
  assert.ok(t.startsWith(C.SNOW4));
  assert.ok(t.endsWith(C.RESET));
  assert.match(t, /v\d+\.\d+\.\d+/);
  assert.ok(t.includes("autonomous"));
  assert.ok(t.includes("free"));
  assert.ok(t.includes("multi-provider"));
  assert.ok(t.includes("freellmapi"));
});

test("renderLogo writes logo + tagline + blank line to stdout", () => {
  renderLogo();
  const out = captured;
  assert.ok(out.includes(C.LAVA));
  assert.match(out, /v\d+\.\d+\.\d+/);
  // The whole thing ends with a blank line.
  assert.ok(out.endsWith("\n\n"));
});

/* ──────────────────────── Autocomplete commands list ──────────────────────── */

test("COMMANDS_WITH_DESC exposes /exit but not /quit (alias kept handler-only)", () => {
  const cmds = COMMANDS_WITH_DESC.map((c) => c.cmd);
  assert.equal(
    cmds.filter((c) => c === "/exit").length,
    1,
    "exactly one /exit entry",
  );
  assert.equal(
    cmds.filter((c) => c === "/quit").length,
    0,
    "no /quit entry in autocomplete list",
  );
  const exitEntry = COMMANDS_WITH_DESC.find((c) => c.cmd === "/exit")!;
  assert.match(
    exitEntry.desc,
    /quit/i,
    "/exit description mentions /quit alias",
  );
});

/* ──────────────────────── Status bar ──────────────────────── */

test("renderStatusBar writes a single line with `\r` and the four pills", () => {
  const state: CLIState = {
    mode: "BUILD",
    routing: "auto",
    model: "gemini-2.5-flash",
    branch: "main",
    contextPercent: 12,
    providersCount: 3,
    transport: "freellmapi",
  };
  renderStatusBar(state);
  assert.ok(captured.startsWith("\r"));
  assert.ok(!captured.endsWith("\n"));
  assert.ok(captured.includes("BUILD"));
  assert.ok(captured.includes("auto"));
  assert.ok(captured.includes("gemini-2.5-flash"));
  assert.ok(captured.includes("main"));
  assert.ok(captured.includes("ctx: 12% used"));
  assert.ok(captured.includes("88% remaining"));
  assert.ok(captured.includes("3 providers"));
  assert.ok(captured.includes("freellmapi"));
});

test("renderStatusBar clamps contextPercent above 100 and below 0", () => {
  const baseState: CLIState = {
    mode: "BUILD",
    routing: "auto",
    model: "gemini-2.5-flash",
    branch: "main",
    contextPercent: 150,
    providersCount: 0,
    transport: "freellmapi",
  };
  renderStatusBar(baseState);
  assert.ok(captured.includes("100% used"));
  assert.ok(captured.includes("0% remaining"));

  captured = "";
  renderStatusBar({ ...baseState, contextPercent: -5 });
  assert.ok(captured.includes("0% used"));
  assert.ok(captured.includes("100% remaining"));
});

/* ──────────────────────── Provider list ──────────────────────── */

test("renderProviderList marks the selected model with a lava dot", () => {
  const providers: Provider[] = [
    {
      name: "Google (Gemini)",
      hasKey: true,
      models: [
        { id: "gemini-2.5-flash", tags: ["fast", "free"], selected: true },
        { id: "gemini-2.5-pro", tags: ["smart"] },
      ],
    },
  ];
  renderProviderList(providers);
  assert.ok(captured.includes("Google (Gemini)"));
  assert.ok(captured.includes("[key ✓]"));
  assert.ok(captured.includes(`${C.LAVA}◉${C.RESET}`));
  assert.ok(captured.includes("gemini-2.5-flash"));
  assert.ok(captured.includes("gemini-2.5-pro"));
  // Tag rendering
  assert.ok(captured.includes(`${C.LAVA}[fast]${C.RESET}`));
  assert.ok(captured.includes(`${C.GREEN}[free]${C.RESET}`));
  assert.ok(captured.includes(`${C.PURPLE}[smart]${C.RESET}`));
  // Footer hint
  assert.ok(captured.includes("/providers add"));
});

test("renderProviderList shows [no key] in SNOW4 for unconfigured providers", () => {
  const providers: Provider[] = [
    { name: "OpenAI", hasKey: false, models: [{ id: "gpt-4o" }] },
  ];
  renderProviderList(providers);
  assert.ok(captured.includes(`${C.SNOW4}[no key]${C.RESET}`));
  // Unselected dot is SNOW4
  assert.ok(captured.includes(`${C.SNOW4}○${C.RESET}`));
});

/* ──────────────────────── Tool call ──────────────────────── */

test("renderToolCall uses the right icon + colour per kind", () => {
  const cases: Array<[ToolCallRender["kind"], string, string]> = [
    ["read", "✦", C.BLUE],
    ["write", "✎", C.LAVA],
    ["bash", "$", C.YELLOW],
    ["search", "⌕", C.PURPLE],
    ["success", "✓", C.GREEN],
    ["error", "✗", C.RED],
    ["thinking", "◈", C.SNOW3],
  ];
  for (const [kind, icon, color] of cases) {
    captureStdout();
    renderToolCall({ kind, name: "X", detail: "detail" });
    assert.ok(captured.includes(`${color}${icon}${C.RESET}`), `kind=${kind}`);
  }
});

test("renderToolCall pads the tool name to 12 chars for alignment", () => {
  renderToolCall({ kind: "read", name: "ReadFile", detail: "src/x.ts" });
  // The visible width of the name in the line is exactly 12.
  const line = captured.split("\n")[0]!;
  // Strip ANSI escapes and pull out the name segment.
  const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
  // The pattern is: 2 spaces + icon + 2 spaces + name (12 chars) + 2 spaces + detail.
  const m = stripped.match(/  ✦  (.{12})  /);
  assert.ok(
    m,
    `expected '  ✦  <12-char-name>  ' in: ${JSON.stringify(stripped)}`,
  );
});

test("startInlineToolSpinner: succeed() replaces ⠋ with ✔ summary on one line", () => {
  // Non-TTY mode keeps the test deterministic (no ticking, no
  // setInterval). The handle uses `\r\x1b[K` to overwrite in place.
  Object.defineProperty(process.stdout, "isTTY", {
    value: undefined,
    configurable: true,
  });
  const handle = startInlineToolSpinner({
    kind: "read",
    name: "Read",
    detail: "src/index.ts",
  });
  // Initial frame: spinner icon + tool name + detail + ellipsis.
  const stripped = captured.replace(/\x1b\[[0-9;]*m/g, "").replace(/\r/g, "");
  assert.match(stripped, /⠋\s+Read\s+src\/index\.ts…/);
  // Finalise → ✔ marker + summary on the same overwriting line.
  handle.succeed("124 lines (4ms)");
  const finalStripped = captured
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\r/g, "");
  assert.match(finalStripped, /✔\s+Read\s+124 lines \(4ms\)/);
  // The line ends with a newline so the next output starts fresh.
  assert.ok(captured.endsWith("\n"));
});

test("startInlineToolSpinner: fail() emits ✗ + red summary", () => {
  Object.defineProperty(process.stdout, "isTTY", {
    value: undefined,
    configurable: true,
  });
  const handle = startInlineToolSpinner({
    kind: "bash",
    name: "Run",
    detail: "npm test",
  });
  handle.fail("exit code 1");
  const stripped = captured.replace(/\x1b\[[0-9;]*m/g, "").replace(/\r/g, "");
  assert.match(stripped, /✗\s+Run\s+exit code 1/);
  // The failure-state colour escape (red) is present in the raw output.
  assert.ok(captured.includes(C.RED));
});

/* ──────────────────────── Routing banner ──────────────────────── */

test("renderRoutingBanner uses lava-tinted background", () => {
  renderRoutingBanner("MultiAgent", "complex task detected");
  assert.ok(captured.includes(C.LAVA_BG));
  assert.ok(captured.includes("MultiAgent"));
  assert.ok(captured.includes("complex task detected"));
  assert.ok(captured.includes("⇢"));
});

/* ──────────────────────── AI response ──────────────────────── */

test("renderAIResponse wraps the text in a lava-topped box", () => {
  renderAIResponse("Found a bug in foo.ts: it is broken.");
  const lines = captured.split("\n");
  // First line is the top border — should be lava.
  assert.ok(lines[0]!.includes(C.LAVA));
  assert.ok(lines[0]!.includes("┌"));
  // Last non-empty line is the bottom border — should be SNOW4.
  const lastNonEmpty = lines.filter((l) => l.length > 0).pop()!;
  assert.ok(lastNonEmpty.includes(C.SNOW4));
  assert.ok(lastNonEmpty.includes("└"));
  // File path in the body is coloured blue.
  assert.ok(captured.includes(`${C.BLUE}foo.ts${C.RESET}`));
  // Side borders use SNOW4.
  assert.ok(captured.includes(`${C.SNOW4}│${C.RESET}`));
});

test("renderAIResponse colours error keywords in lava and inline code in purple", () => {
  renderAIResponse("Run `npm test` — error: 3 failed.");
  assert.ok(captured.includes(`${C.PURPLE}npm test${C.RESET}`));
  assert.ok(captured.includes(`${C.LAVA}error${C.RESET}`));
  assert.ok(captured.includes(`${C.LAVA}failed${C.RESET}`));
});

test("renderAIResponse colours arrow-prefix lines specially", () => {
  renderAIResponse("→ applying fix now");
  // The arrow (with the trailing space) is wrapped in lava.
  assert.ok(captured.includes(`${C.LAVA}→ ${C.RESET}`));
  // The rest of the line is rendered in dim (SNOW4) — the
  // `applying fix now` substring sits inside a SNOW4 segment.
  assert.ok(captured.includes(`${C.SNOW4}applying fix now${C.RESET}`));
});

/* ──────────────────────── Cost line ──────────────────────── */

test("renderCostLine formats the four stats with toLocaleString and dim colour", () => {
  renderCostLine("gemini-2.5-flash", 4821, 3, 6200);
  assert.ok(captured.startsWith("  "));
  assert.ok(captured.includes("gemini-2.5-flash"));
  assert.ok(captured.includes("4,821 tokens"));
  assert.ok(captured.includes("3 tool calls"));
  assert.ok(captured.includes("6.2s"));
  assert.ok(captured.includes(C.SNOW4));
});

/* ──────────────────────── Mode selector ──────────────────────── */

test("renderModeSelector marks the active mode with ◉ + lava badge", () => {
  renderModeSelector({
    title: "EXECUTION MODE",
    modes: [
      { id: "plan", label: "PLAN", description: "read-only" },
      { id: "build", label: "BUILD", description: "full autonomy" },
    ],
    selected: "build",
  });
  assert.ok(captured.includes("EXECUTION MODE"));
  assert.ok(captured.includes("PLAN"));
  assert.ok(captured.includes("BUILD"));
  // The selected id has the lava dot, the unselected has the dim dot.
  assert.ok(captured.includes(`${C.LAVA}◉${C.RESET}`));
  assert.ok(captured.includes(`${C.SNOW4}○${C.RESET}`));
  // The active badge
  assert.ok(captured.includes("active"));
  assert.ok(captured.includes(C.LAVA_BG));
});

/* ──────────────────────── Session header ──────────────────────── */

test("renderSessionHeader prints a lava-topped box with provider + model + mode", () => {
  renderSessionHeader({
    status: "new",
    startedAt: "2026-06-06T14:42:00Z",
    provider: "Google (Gemini)",
    model: "gemini-2.5-flash",
    mode: "BUILD",
    routing: "auto",
    contextWindow: "200k",
  });
  const lines = captured.split("\n");
  // Top border — LAVA colour.
  assert.ok(lines[0]!.includes(C.LAVA));
  assert.ok(lines[0]!.includes("SESSION"));
  // Bottom border — LAVA colour.
  const bottom = lines.filter((l) => l.includes("└")).pop()!;
  assert.ok(bottom.includes(C.LAVA));
  // The provider name uses the Google brand colour.
  assert.ok(captured.includes(`${C.P_GOOGLE}Google (Gemini)${C.RESET}`));
  // The model uses blue.
  assert.ok(captured.includes(`${C.BLUE}gemini-2.5-flash${C.RESET}`));
  // The mode uses lava.
  assert.ok(captured.includes(`${C.LAVA}BUILD${C.RESET}`));
});

test("renderSessionHeader shows the human-readable started-at", () => {
  renderSessionHeader({
    status: "new",
    startedAt: "2026-06-06T14:42:00Z",
    provider: "OpenAI",
    model: "gpt-4o",
    mode: "PLAN",
    routing: "single",
    contextWindow: "128k",
  });
  assert.ok(captured.includes("New session"));
  // The toLocaleString output should appear (en-US format).
  assert.ok(captured.match(/[A-Z][a-z]{2} \d+, \d{4}/));
});

/* ──────────────────────── Plan renderer ──────────────────────── */

test("renderPlan prints numbered steps with state-appropriate dots", () => {
  const steps: PlanStep[] = [
    { text: "Read src/foo.ts", state: "done" },
    { text: "Apply fix", state: "active" },
    { text: "Run tests", state: "pending" },
  ];
  renderPlan(steps);
  const lines = captured.split("\n");
  // Title rule.
  assert.ok(captured.includes("PLAN"));
  // Numbered rows present.
  assert.ok(captured.includes("1"));
  assert.ok(captured.includes("2"));
  assert.ok(captured.includes("3"));
  // State-specific glyphs.
  assert.ok(captured.includes(`${C.GREEN}✓${C.RESET}`));
  assert.ok(captured.includes(`${C.LAVA}◉${C.RESET}`));
  assert.ok(captured.includes(`${C.SNOW4}○${C.RESET}`));
  // Approval prompt with lava [Y/n].
  assert.ok(captured.includes(`${C.LAVA}[Y/n]${C.RESET}`));
  assert.ok(captured.includes("Approve plan?"));
});
