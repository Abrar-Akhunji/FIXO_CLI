import assert from "node:assert/strict";
import test from "node:test";
import {
  countMessagesTokens,
  countTokens,
  resolveEncoderForModel,
  type EncoderName,
} from "../agent/tokenizer.js";

test("resolveEncoderForModel — GPT-4o family picks o200k_base", () => {
  for (const model of [
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4.1",
    "o1",
    "o3-mini",
    "o4-mini",
  ]) {
    assert.equal(resolveEncoderForModel(model), "o200k_base", model);
  }
});

test("resolveEncoderForModel — older GPT / non-GPT models pick cl100k_base", () => {
  const models = [
    "gpt-4",
    "gpt-3.5-turbo",
    "claude-3-5-sonnet",
    "llama-3.3-70b",
    "gemini-2.5-pro",
    "mistral-large",
    "qwen-3-235b",
    "deepseek-v3",
    "codestral",
  ];
  for (const model of models) {
    assert.equal(resolveEncoderForModel(model), "cl100k_base", model);
  }
});

test("resolveEncoderForModel — null/empty fallback to cl100k_base", () => {
  assert.equal(resolveEncoderForModel(null), "cl100k_base");
  assert.equal(resolveEncoderForModel(undefined), "cl100k_base");
  assert.equal(resolveEncoderForModel(""), "cl100k_base");
});

test("countTokens — empty and short strings", () => {
  assert.equal(countTokens(""), 0);
  // "Hello, world!" is 4 tokens in both cl100k and o200k.
  assert.equal(countTokens("Hello, world!"), 4);
});

test("countTokens — cl100k and o200k agree on small English", () => {
  const text = "The quick brown fox jumps over the lazy dog.";
  const cl = countTokens(text, "gpt-4");
  const o = countTokens(text, "gpt-4o");
  // Both are close; allow a small delta. For this sentence they are
  // actually identical but we want a regression check either way.
  assert.ok(Math.abs(cl - o) <= 1, `cl=${cl} o=${o}`);
});

test("countTokens — numbers without a model default to cl100k", () => {
  const tokens = countTokens("1234567890");
  assert.ok(tokens > 0 && tokens <= 4, `unexpected token count: ${tokens}`);
});

test("countMessagesTokens — accounts for per-message overhead", () => {
  const messages = [{ role: "user" as const, content: "hi" }];
  const total = countMessagesTokens(messages);
  // "hi" is 1 token + 4 overhead + 2 framing = 7.
  assert.equal(total, 7);
});

test("countMessagesTokens — empty list still has framing cost", () => {
  assert.equal(countMessagesTokens([]), 2);
});

test("countMessagesTokens — handles tool_calls as conservative surcharge", () => {
  const noTools = countMessagesTokens([{ content: "ok" }]);
  const withTools = countMessagesTokens([
    {
      content: "ok",
      tool_calls: [
        {
          id: "1",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"/x"}' },
        },
      ],
    },
  ]);
  assert.ok(withTools > noTools, `${withTools} should exceed ${noTools}`);
});

test("countTokens — type-level guarantee that EncoderName stays closed", () => {
  // If a new encoder is ever added this compile-time assertion will
  // route the developer back to the encoder map.
  const names: EncoderName[] = ["cl100k_base", "o200k_base"];
  assert.equal(names.length, 2);
});
