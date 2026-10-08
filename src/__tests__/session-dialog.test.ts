import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionDialog, DIALOG_CANCEL } from "../ui/session-dialog.js";
import { SessionScreen } from "../ui/session-screen.js";
import { cellWidth, layoutComposer, wrapStyledText } from "../ui/terminal-text.js";
import { MarkdownStreamRenderer } from "../ui/markdown-stream.js";
import { AgentClient } from "../agent/agent-client.js";
import * as prompts from "../ui/prompts.js";
import { modelCommand, providersCommand } from "../ui/commands/model-commands.js";
import type { CommandContext } from "../ui/commands/types.js";
import { ProvidersManager } from "../agent/providers-manager.js";
import { getDefaultConfig, loadConfig } from "../config.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const plain = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

function fixture(rows = 30, cols = 90) {
  const chunks: string[] = [];
  const lines = new Map<number, string>();
  const io = { rows, cols, write(chunk: string) {
    chunks.push(chunk);
    for (const match of chunk.matchAll(/\x1b\[(\d+);1H\x1b\[2K([^]*?)(?=\x1b\[\d+;\d+H|$)/g)) {
      lines.set(Number(match[1]), plain(match[2]));
    }
  } };
  const screen = new SessionScreen({ mode: "BUILD", model: "auto" }, io);
  screen.open();
  return { screen, chunks, io, visible: () => [...lines].sort(([a], [b]) => a - b).map(([, value]) => value).join("\n") };
}

test("search, scrolling, empty results and cancellation stay inside the native dialog", () => {
  let chosen: string | symbol | undefined;
  const dialog = new SessionDialog({ message: "Models", options: Array.from({ length: 40 }, (_, i) => ({ value: `model-${i}`, label: `model-${i}` })) }, (value) => { chosen = value; });
  dialog.input("model-3");
  assert.ok(dialog.view(12, 70).some((row) => row.text.includes("1 / 11")));
  dialog.input("\x1b[6~");
  assert.ok(dialog.view(12, 70).some((row) => row.text.startsWith("› model-37")));
  dialog.input("\x15does-not-exist\r");
  assert.equal(chosen, undefined);
  assert.ok(dialog.view(12, 70).some((row) => row.text.includes("No matches")));
  dialog.input("\x1b");
  assert.equal(chosen, DIALOG_CANCEL);
});

test("fragmented bracketed paste is masked, validated, and never submits by itself", () => {
  let chosen: string | symbol | undefined;
  const dialog = new SessionDialog<string>({ message: "Key", password: true, validate: (value) => value ? undefined : "Required" }, (value) => { chosen = value; });
  dialog.input("\r");
  assert.ok(dialog.view(10, 70).some((row) => row.text.includes("Required")));
  for (const part of ["\x1b[20", "0~ sk-test-", "secret\r\n", "\x1b[20", "1~"]) dialog.input(part);
  assert.equal(chosen, undefined);
  assert.ok(!JSON.stringify(dialog.view(10, 70)).includes("secret"));
  dialog.input("\rignored-after-submit");
  assert.equal(chosen, "sk-test-secret");
});

test("cursor edits and deletion update the actual submitted value", () => {
  let chosen: string | symbol | undefined;
  const dialog = new SessionDialog<string>({ message: "Key", password: true }, (value) => { chosen = value; });
  dialog.input("sk-typo\x1b[D\x7f\x1b[3~ok\r");
  assert.equal(chosen, "sk-tyok");
});

test("native dialogs preserve composer and alternate screen; close settles queued prompts", async () => {
  const f = fixture();
  try {
    f.screen.appendUserMessage("a question");
    f.screen.setComposer("unsent draft");
    const first = prompts.select({ message: "Providers", options: [{ value: "zen", label: "Zen (OpenCode)" }] });
    const second = prompts.confirm({ message: "Confirm" });
    await tick();
    assert.ok(f.visible().includes("Zen (OpenCode)"));
    assert.ok(!f.visible().includes("unsent draft"));
    f.screen.inputDialog("\r");
    assert.equal(await first, "zen");
    await tick();
    f.screen.inputDialog("\x1b");
    assert.ok(prompts.isCancel(await second));
    await tick();
    assert.ok(f.visible().includes("unsent draft"));
    assert.ok(f.visible().includes("a question"));
    assert.ok(!f.chunks.join("").includes("\x1b[?1049l"));
    const pending = prompts.password({ message: "Secret" });
    const queued = prompts.confirm({ message: "Queued" });
    f.screen.close();
    assert.ok(prompts.isCancel(await pending));
    assert.ok(prompts.isCancel(await queued));
  } finally { f.screen.close(); }
});

test("role labels and padded composer survive resize and Unicode layout", async () => {
  const f = fixture();
  try {
    f.screen.appendUserMessage("你好 👩‍💻 question");
    f.screen.beginAssistantMessage();
    f.screen.endAssistantMessage();
    f.screen.setComposer("draft");
    await tick();
    assert.ok(f.visible().includes("╭─ You"));
    assert.ok(f.visible().includes("◈  FIXO"));
    assert.ok(f.visible().includes("│ draft"));
    f.io.rows = 16; f.io.cols = 35;
    f.screen.setActivity("resized");
    await tick();
    assert.ok(f.visible().includes("│ draft"));
    assert.equal(cellWidth("你好 👩‍💻"), 7);
    const rows = wrapStyledText("\x1b[1m你好👩‍💻abc\x1b[0m", 4);
    assert.ok(rows.every((row) => cellWidth(row) <= 4));
    assert.equal(rows.map(plain).join(""), "你好👩‍💻abc");
  } finally { f.screen.close(); }
});

test("long drafts wrap inside the composer and the cursor remains visible", () => {
  const draft = layoutComposer("0123456789".repeat(9), 90, 12, 3);
  assert.equal(draft.lines.length, 3);
  assert.equal(draft.cursorRow, 2);
  assert.equal(draft.cursorColumn, 6);
  assert.ok(draft.lines.every((line) => cellWidth(line) <= 12));
  const unicode = layoutComposer("你好👩‍💻abc", 7, 6, 3);
  assert.ok(unicode.cursorColumn <= 6);
});

test("streamed Markdown code borders fit the transcript and preserve long code", async () => {
  const f = fixture(30, 70);
  const originalWrite = process.stdout.write;
  let captured = "";
  try {
    process.stdout.write = ((chunk: string) => { captured += chunk; return true; }) as typeof process.stdout.write;
    const renderer = new MarkdownStreamRenderer();
    renderer.write("```ts\n" + "a".repeat(110) + "\n```\n");
    renderer.flush();
    const rows = captured.trimEnd().split("\n");
    assert.ok(rows.every((row) => cellWidth(row) <= f.screen.transcriptWidth()));
    assert.equal((plain(captured).match(/a/g) ?? []).length, 110);
    assert.ok(!/\x1b\[\d+A/.test(captured));
  } finally { process.stdout.write = originalWrite; f.screen.close(); }
});

test("proxy-mode session can select Zen and see only Zen's models, then route directly", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-dialog-test-"));
  const previous = process.env.FIXO_HOME;
  const originalFetch = globalThis.fetch;
  process.env.FIXO_HOME = stateDir;
  ProvidersManager.resetVault();
  const f = fixture();
  try {
    ProvidersManager.add("zen", "fake-zen-key");
    ProvidersManager.add("groq", "fake-groq-key");
    const config = getDefaultConfig();
    config.provider_mode = "proxy";
    config._firstRunComplete = true;
    const requested: string[] = [];
    globalThis.fetch = (async (url) => {
      requested.push(String(url));
      return new Response(JSON.stringify({ data: [{ id: "zen-alpha" }, { id: "zen-beta" }] }));
    }) as typeof fetch;
    const ctx = { config, args: [], state: { currentModel: "auto" }, conversation: { setContextLimit() {} } } as unknown as CommandContext;
    const flow = modelCommand(ctx);
    await tick();
    assert.ok(f.visible().includes("Choose a provider"));
    assert.ok(f.visible().includes("Zen (OpenCode)"));
    f.screen.inputDialog("zen\r");
    await tick(); await tick();
    assert.ok(f.visible().includes("Zen (OpenCode) / 2 models"));
    assert.ok(!f.visible().includes("Groq"));
    assert.equal(requested.length, 1);
    assert.ok(requested[0].includes("opencode"));
    f.screen.inputDialog("beta\r");
    await flow;
    assert.equal(ctx.state.currentModel, "zen-beta");
    assert.equal(config.provider_mode, "direct");
    assert.deepEqual(config.directProvider, { name: "zen", defaultModel: "zen-beta" });
    assert.equal(loadConfig().lastSession?.provider, "zen");
    assert.ok(!f.chunks.join("").includes("\x1b[?1049l"));

    // Esc from a provider's models returns to the provider scope; no mutation.
    const backFlow = modelCommand(ctx);
    await tick(); f.screen.inputDialog("zen\r");
    await tick(); await tick(); f.screen.inputDialog("\x1b");
    await tick();
    assert.ok(f.visible().includes("Choose a provider"));
    f.screen.inputDialog("\x1b");
    await backFlow;
    assert.equal(ctx.state.currentModel, "zen-beta");

    // Provider management is also native, and offers a model action for keys.
    const providers = providersCommand(ctx);
    await tick(); f.screen.inputDialog("zen\r");
    await tick();
    assert.ok(f.visible().includes("Choose a model"));
    f.screen.inputDialog("\x1b");
    await providers;

    // Explicitly choosing proxy must beat the existing direct model-id hint.
    config.freellmapi_api_key = "fake-proxy-key";
    config.apiUrl = "https://example.test/v1";
    const proxyFlow = modelCommand(ctx);
    await tick(); f.screen.inputDialog("proxy\r");
    await tick(); await tick(); f.screen.inputDialog("beta\r");
    await proxyFlow;
    assert.equal(config.provider_mode, "proxy");
    assert.equal(config.lastSession?.provider, "auto");
    const client = new AgentClient("fake-proxy-key", config.apiUrl, false, "proxy");
    const resolve = (client as unknown as { resolveDirectConfig(model: string): unknown }).resolveDirectConfig.bind(client);
    assert.equal(resolve("zen-beta"), null);

    // Adding a key goes directly to that provider's model picker, still native.
    const addFlow = providersCommand({ ...ctx, args: ["add", "openai"] });
    await tick();
    f.screen.inputDialog("\x1b[200~fake-new-key\x1b[201~");
    await tick();
    assert.ok(!f.chunks.join("").includes("fake-new-key"));
    f.screen.inputDialog("\r");
    await tick(); await tick();
    assert.ok(f.visible().includes("OpenAI / 2 models"));
    f.screen.inputDialog("alpha\r");
    await addFlow;
    assert.equal(config.lastSession?.provider, "openai");
    assert.equal(config.provider_mode, "direct");
    assert.ok(!f.chunks.join("").includes("\x1b[?1049l"));
  } finally {
    f.screen.close(); globalThis.fetch = originalFetch;
    ProvidersManager.resetVault();
    if (previous === undefined) delete process.env.FIXO_HOME; else process.env.FIXO_HOME = previous;
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
