import { test } from 'node:test';
import * as assert from 'node:assert';
import { createStructuredPlan } from '../planner.js';
import { evaluateInputIntent } from '../agent/single-agent.js';
import { ConversationManager } from '../agent/conversation.js';
import { DEFAULT_API_URL } from '../config.js';

test('Sprint 2 Heuristics and Intent Classification', async (t) => {
  await t.test('createStructuredPlan ignores domains and version numbers', () => {
    const plan = createStructuredPlan('fix bugs in index.ts and check google.com or v2.0 package');
    assert.deepEqual(plan.expectedFiles, ['index.ts']);
  });

  await t.test('evaluateInputIntent strictly matches word boundaries', () => {
    assert.equal(evaluateInputIntent('explain the code'), 'CHAT_ONLY');
    assert.equal(evaluateInputIntent('refactor the validation list component'), 'MUTATION');
    assert.equal(evaluateInputIntent('show me why this fails'), 'CHAT_ONLY');
    assert.equal(evaluateInputIntent('why does it do that'), 'CHAT_ONLY');
    assert.equal(evaluateInputIntent('playlist manager implementation'), 'MUTATION');
    assert.equal(evaluateInputIntent('find vulnerabilities in codebase and list them'), 'MUTATION');
    assert.equal(evaluateInputIntent('explain index.ts'), 'MUTATION');
  });
});

test('Sprint 2 Conversation Pruning and Centralized Defaults', async (t) => {
  await t.test('DEFAULT_API_URL is configured', () => {
    assert.equal(DEFAULT_API_URL, 'https://api.freellmapi.com/v1');
  });

  await t.test('ConversationManager turn-aware pruning retains complete turns', () => {
    const manager = new ConversationManager(100); // very small budget to force pruning
    // Add multiple messages
    manager.addTurn('User message 1', 'Assistant response 1');
    manager.addTurn('User message 2', 'Assistant response 2');
    manager.addTurn('User message 3', 'Assistant response 3');
    
    // Total tokens will exceed 100 easily because we added 3 turns.
    // The pruning should run.
    manager.pruneToFitBudget();
    
    const history = manager.exportHistory();
    // It should keep at least MIN_MESSAGES_TO_KEEP (4) messages.
    assert.ok(history.length >= 4);
    // The oldest message in the history should be a 'user' message (turn start), not 'assistant' or 'tool'.
    assert.equal(history[0].role, 'user');
  });
});
