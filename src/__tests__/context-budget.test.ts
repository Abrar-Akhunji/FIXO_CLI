import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatMessage } from '../shared/types.js';
import { ContextBudgetEnforcer, TokenCounter } from '../agent/context-budget.js';

function makeUserMsg(content: string): ChatMessage {
  return { role: 'user', content };
}
function makeAssistantMsg(content: string): ChatMessage {
  return { role: 'assistant', content };
}
function makeToolMsg(content: string): ChatMessage {
  return { role: 'tool', content, tool_call_id: 't1' };
}

test('TokenCounter — count("Hello") matches countTokens()', () => {
  const counter = new TokenCounter('gpt-4o');
  assert.equal(counter.count('Hello'), countTokensDirect('Hello', 'gpt-4o'));
});

test('TokenCounter — countMessages sums overhead + content', () => {
  const counter = new TokenCounter();
  const messages: ChatMessage[] = [makeUserMsg('hi'), makeAssistantMsg('hello')];
  // 2 messages × 4 overhead = 8, + 1 + 1 = 10, + 2 framing = 12.
  assert.equal(counter.countMessages(messages), 12);
});

// Use a dynamic import to avoid pulling tokenizer into a global
// dependency in case the test file is loaded in a stripped context.
import { countTokens as countTokensDirect } from '../agent/tokenizer.js';

test('enforce — within budget returns "none" action unchanged', () => {
  const enforcer = new ContextBudgetEnforcer('gpt-4o');
  const messages = [makeUserMsg('hi'), makeAssistantMsg('hello')];
  const { messages: out, report } = enforcer.enforce(messages, { maxTokens: 1000 });
  assert.equal(out.length, 2);
  assert.deepEqual(report.actions, ['none']);
  assert.equal(report.withinBudget, true);
  assert.equal(report.tokensBefore, report.tokensAfter);
});

test('enforce — large tool outputs get pruned first (tier 1)', () => {
  const enforcer = new ContextBudgetEnforcer('gpt-4o');
  // Tool content is over the 2,000-char prune threshold but small
  // enough that the *pruned* result fits within `maxTokens` on its
  // own. This isolates the test to tier 1.
  const oversized = 'x'.repeat(2_500);
  const messages = [
    makeUserMsg('start'),
    makeAssistantMsg('calling tool'),
    makeToolMsg(oversized),
    makeUserMsg('next'),
    makeAssistantMsg('ok'),
  ];
  const { messages: out, report } = enforcer.enforce(messages, {
    maxTokens: 300,
    tailMessages: 2,
  });
  assert.equal(report.actions[0], 'prune-tool-outputs', JSON.stringify(report));
  assert.equal(report.withinBudget, true);
  // The tool message (index 2) was non-tail and should have been pruned.
  const tool = out[2];
  assert.ok(tool, `out[2] is undefined; out has ${out.length} elements`);
  // After Phase 2 the content union widened to allow content blocks;
  // pruned tool messages are always plain strings.
  assert.equal(typeof tool.content, 'string');
  assert.ok((tool.content as string).includes('[pruned:'));
});

test('enforce — oldest turns are dropped if pruning is insufficient (tier 2)', () => {
  const enforcer = new ContextBudgetEnforcer('gpt-4o');
  // 6 turns of moderate size. maxTokens is set so that tier 1 (no
  // oversized tool outputs) does nothing and tier 2 (drop oldest
  // turn-pairs) is required to fit the budget.
  const messages: ChatMessage[] = [];
  for (let i = 0; i < 6; i++) {
    messages.push(makeUserMsg(`u${i}: ${'a'.repeat(50)}`));
    messages.push(makeAssistantMsg(`a${i}: ${'b'.repeat(50)}`));
  }
  const { messages: out, report } = enforcer.enforce(messages, {
    maxTokens: 150,
    tailMessages: 4,
  });
  assert.ok(report.actions.includes('drop-oldest-turns'), JSON.stringify(report));
  assert.ok(out.length < messages.length, `${out.length} < ${messages.length}`);
  assert.equal(report.withinBudget, true);
  // The last 4 messages (one user/assistant pair in the tail of 4)
  // must survive the splice.
  assert.deepEqual(
    out.slice(-4).map((m) => m.content),
    messages.slice(-4).map((m) => m.content),
  );
});

test('enforce — huge tool-call args get truncated (tier 3)', () => {
  const enforcer = new ContextBudgetEnforcer('gpt-4o');
  const messages: ChatMessage[] = [
    makeUserMsg('do it'),
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: '1',
          type: 'function',
          function: {
            name: 'read_file',
            arguments: JSON.stringify({ content: 'y'.repeat(20_000) }),
          },
        },
      ],
    },
  ];
  const { messages: out, report } = enforcer.enforce(messages, {
    maxTokens: 5,
    tailMessages: 2,
  });
  assert.ok(report.actions.includes('truncate-tool-args'), JSON.stringify(report));
  const tc = out[1].tool_calls![0];
  assert.ok(tc.function.arguments.length < 20_000);
  assert.ok(tc.function.arguments.endsWith('..."}'));
});

test('enforce — marks for compaction when even tier 3 is insufficient', () => {
  const enforcer = new ContextBudgetEnforcer('gpt-4o');
  const messages: ChatMessage[] = [];
  for (let i = 0; i < 8; i++) {
    messages.push(makeUserMsg(`u${i}: ${'a'.repeat(500)}`));
    messages.push(makeAssistantMsg(`a${i}: ${'b'.repeat(500)}`));
  }
  const { report } = enforcer.enforce(messages, {
    maxTokens: 1, // absurdly low to force mark-for-compaction
    tailMessages: 4,
  });
  assert.equal(report.markForCompaction, true);
  assert.equal(report.withinBudget, false);
  assert.ok(report.actions.includes('mark-for-compaction'));
});

test('enforce — does not mutate the input array', () => {
  const enforcer = new ContextBudgetEnforcer('gpt-4o');
  const messages = [makeUserMsg('hi'), makeAssistantMsg('hello')];
  const snapshot = JSON.stringify(messages);
  enforcer.enforce(messages, { maxTokens: 1, tailMessages: 2 });
  assert.equal(JSON.stringify(messages), snapshot);
});

test('enforce — empty list is a no-op', () => {
  const enforcer = new ContextBudgetEnforcer('gpt-4o');
  const { messages: out, report } = enforcer.enforce([], { maxTokens: 10 });
  assert.deepEqual(out, []);
  assert.deepEqual(report.actions, ['none']);
  assert.equal(report.withinBudget, true);
});
