/**
 * direct-mode-bootstrap.test.ts — Phase 1.1 acceptance test.
 *
 * Proves the Phase 1 safety contract: when the CLI is constructed in
 * direct-provider mode and the model resolves to a configured direct
 * provider, the request goes straight to that provider's base URL
 * with **zero** packets to the FreeLLMAPI proxy.
 *
 * Also proves the corollary: when direct mode is selected but the
 * model name does not resolve to any direct provider in the vault,
 * the client throws `DirectModelUnresolvedError` instead of silently
 * leaking to the proxy.
 *
 * Each case pins `$HOME` to a fresh `mkdtempSync` directory so the
 * `~/.fixocli/providers.json` write does not touch the developer's
 * real config.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AgentClient,
  DirectModelUnresolvedError,
} from "../agent/agent-client.js";
import { ProvidersManager } from "../agent/providers-manager.js";

type FetchFn = typeof globalThis.fetch;

function mkHome(): { home: string; restore: () => void } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-direct-mode-"));
  const originalHome = process.env.HOME;
  const originalFetch = globalThis.fetch;
  process.env.HOME = tmp;
  ProvidersManager.resetVault();
  return {
    home: tmp,
    restore: () => {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      globalThis.fetch = originalFetch;
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      ProvidersManager.resetVault();
    },
  };
}

test("direct mode — chat() routes to OpenAI base URL, never to FreeLLMAPI proxy", async () => {
  const ctx = mkHome();
  try {
    ProvidersManager.add("openai", "sk-test-direct-key-abc123");

    const seenUrls: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      const url = typeof input === "string" ? input : String(input);
      seenUrls.push(url);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          model: "gpt-4o",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as FetchFn;

    const client = new AgentClient("", undefined, false, "direct");
    const result = await client.chat(
      [{ role: "user", content: "hi" }],
      "gpt-4o",
    );

    assert.equal(result.content, "ok");
    assert.equal(seenUrls.length, 1, "exactly one HTTP call expected");
    assert.equal(
      seenUrls[0],
      "https://api.openai.com/v1/chat/completions",
      "direct mode must route to OpenAI base URL",
    );
    for (const url of seenUrls) {
      assert.equal(
        url.includes("freellm-for-fixo.vercel.app"),
        false,
        `direct mode must never hit FreeLLMAPI proxy, saw: ${url}`,
      );
    }
  } finally {
    ctx.restore();
  }
});

test("direct mode — unknown model throws DirectModelUnresolvedError instead of falling through to proxy", async () => {
  const ctx = mkHome();
  try {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as FetchFn;

    const client = new AgentClient("", undefined, false, "direct");
    await assert.rejects(
      () =>
        client.chat(
          [{ role: "user", content: "hi" }],
          "totally-unknown-model-xyz-9999",
        ),
      (err: unknown) => {
        assert.ok(
          err instanceof DirectModelUnresolvedError,
          `expected DirectModelUnresolvedError, got ${err}`,
        );
        assert.match(
          (err as Error).message,
          /direct provider/i,
          "error message should hint at provider configuration",
        );
        return true;
      },
    );
    assert.equal(
      fetchCalled,
      false,
      "no HTTP call must be issued when direct-mode resolution fails",
    );
  } finally {
    ctx.restore();
  }
});

test("direct mode — chatStream() also refuses to leak to proxy on unresolved model", async () => {
  const ctx = mkHome();
  try {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as FetchFn;

    const client = new AgentClient("", undefined, false, "direct");
    await assert.rejects(
      async () => {
        for await (const _chunk of client.chatStream(
          [{ role: "user", content: "hi" }],
          "totally-unknown-model-xyz-9999",
        )) {
          // unreachable
        }
      },
      (err: unknown) => err instanceof DirectModelUnresolvedError,
    );
    assert.equal(
      fetchCalled,
      false,
      "chatStream must not hit the network when direct-mode resolution fails",
    );
  } finally {
    ctx.restore();
  }
});

test("proxy mode (back-compat default) — unknown model still routes to the proxy base URL", async () => {
  const ctx = mkHome();
  try {
    const seenUrls: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      seenUrls.push(typeof input === "string" ? input : String(input));
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          model: "whatever",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as FetchFn;

    const client = new AgentClient(
      "test-proxy-key",
      "https://example-proxy.local/v1",
      false,
      "proxy",
    );
    const result = await client.chat(
      [{ role: "user", content: "hi" }],
      "totally-unknown-model-xyz-9999",
    );
    assert.equal(result.content, "ok");
    assert.equal(
      seenUrls[0],
      "https://example-proxy.local/v1/chat/completions",
    );
  } finally {
    ctx.restore();
  }
});
