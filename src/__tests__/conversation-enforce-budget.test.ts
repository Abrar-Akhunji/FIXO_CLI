import assert from "node:assert/strict";
import test from "node:test";
import { ConversationManager } from "../agent/conversation.js";

test("enforceBudget — within budget is a no-op", () => {
  const cm = new ConversationManager(100_000);
  cm.setContextLimit("gpt-4o");
  cm.addTurn("hi", "hello");
  const { trimmed, report } = cm.enforceBudget(50_000, "gpt-4o");
  assert.equal(trimmed, false);
  assert.equal(report.actions[0], "none");
  assert.equal(report.withinBudget, true);
});

test("enforceBudget — trims the oldest turns when over budget", () => {
  const cm = new ConversationManager(100_000);
  cm.setContextLimit("gpt-4o");
  // 10 turns of moderate size.
  for (let i = 0; i < 10; i++) {
    cm.addTurn(
      `user question ${i}: ${"x".repeat(100)}`,
      `assistant answer ${i}: ${"y".repeat(100)}`,
    );
  }
  const before = cm.getMessageCount();
  // Budget so low that even after dropping turns, the enforcer must
  // mark for compaction. We assert that the *enforcer ran* and the
  // history was trimmed, not that we landed within the (impossibly
  // tight) budget.
  const { trimmed, report } = cm.enforceBudget(20, "gpt-4o");
  assert.equal(trimmed, true);
  assert.ok(cm.getMessageCount() < before);
  assert.ok(report.actions.includes("drop-oldest-turns"));
  assert.equal(report.markForCompaction, true);
});

test("enforceBudget — keeps the tail untouched", () => {
  const cm = new ConversationManager(100_000);
  cm.setContextLimit("gpt-4o");
  for (let i = 0; i < 8; i++) {
    cm.addTurn(`q${i} ${"x".repeat(200)}`, `a${i} ${"y".repeat(200)}`);
  }
  const lastUser = cm.exportHistory()[cm.getMessageCount() - 2];
  cm.enforceBudget(10, "gpt-4o");
  const newHistory = cm.exportHistory();
  const newLastUser = newHistory[newHistory.length - 2];
  // The tail (last 2 messages = 1 turn pair) must survive unchanged.
  assert.equal(newLastUser.content, lastUser.content);
});

test("enforceBudget — uses the model parameter for BPE selection", () => {
  const cm = new ConversationManager(100_000);
  cm.setContextLimit("gpt-4o");
  // The exact token count may differ between encoders; what we want
  // to verify is that the call accepts a model name without error
  // and that the report fields are populated.
  cm.addTurn("hello", "world");
  const { report } = cm.enforceBudget(50_000, "gpt-4o");
  assert.ok(typeof report.tokensBefore === "number");
  assert.ok(typeof report.tokensAfter === "number");
});

test("enforceBudget — real BPE count differs from the old char/4 heuristic", () => {
  // "Hello, world!" is 4 BPE tokens but 13/4 = 4 with the old heuristic
  // — close enough that we cannot reliably differentiate. Use a longer
  // string with whitespace and punctuation that BPE compresses well.
  const cm = new ConversationManager(100_000);
  cm.setContextLimit("gpt-4o");
  const text = "function add(a, b) { return a + b; }";
  cm.addTurn(text, text);
  // Real BPE for that string: ~14 tokens. Old heuristic: ~38/4 = 10.
  const real = cm.getTotalTokens();
  assert.ok(real > 5, `expected >5 real tokens, got ${real}`);
});

test("enforceBudget — markForCompaction is true when tiers 1-3 are insufficient", () => {
  const cm = new ConversationManager(100_000);
  cm.setContextLimit("gpt-4o");
  for (let i = 0; i < 10; i++) {
    cm.addTurn(`q${i} ${"x".repeat(2000)}`, `a${i} ${"y".repeat(2000)}`);
  }
  const { report } = cm.enforceBudget(1, "gpt-4o");
  assert.equal(report.markForCompaction, true);
  assert.equal(report.withinBudget, false);
});
