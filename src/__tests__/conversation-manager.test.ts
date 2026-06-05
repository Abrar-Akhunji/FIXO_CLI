import { test } from 'node:test';
import * as assert from 'node:assert';
import { ConversationManager } from '../agent/conversation.js';
import type { ChatMessage } from '../shared/types.js';

test('ConversationManager Tests', async (t) => {
  await t.test('addTurn and clear basic operations', () => {
    const manager = new ConversationManager(1000);
    manager.addTurn('User Query 1', 'Assistant response 1');
    
    const history = manager.exportHistory();
    assert.equal(history.length, 2);
    assert.equal(history[0].role, 'user');
    assert.equal(history[0].content, 'User Query 1');
    assert.equal(history[1].role, 'assistant');
    assert.equal(history[1].content, 'Assistant response 1');

    manager.clear();
    assert.equal(manager.exportHistory().length, 0);
    assert.equal(manager.getSummary(), '');
  });

  await t.test('pruneToFitBudget trims properly starting at user message boundary', () => {
    // Setup a conversation manager with a very small token budget
    const manager = new ConversationManager(15);
    
    // Add 4 complete turns (user + assistant)
    manager.addTurn('User message 1', 'Assistant response 1'); // Turn 1
    manager.addTurn('User message 2', 'Assistant response 2'); // Turn 2
    manager.addTurn('User message 3', 'Assistant response 3'); // Turn 3
    manager.addTurn('User message 4', 'Assistant response 4'); // Turn 4

    manager.pruneToFitBudget();

    const history = manager.exportHistory();
    // The history should be trimmed
    assert.ok(history.length < 8);
    // The first remaining message MUST be a user message
    assert.equal(history[0].role, 'user');
    // Ensure that it keeps the minimum messages to keep (usually 4)
    assert.ok(history.length >= 4);
  });

  await t.test('importHistory with invalid/unpaired structures retains user start', () => {
    const manager = new ConversationManager(5);
    const complexHistory: ChatMessage[] = [
      { role: 'assistant', content: 'Assistant turn 0' },
      { role: 'tool', tool_call_id: '1', content: 'Tool turn 1' },
      { role: 'user', content: 'User turn 2' },
      { role: 'assistant', content: 'Assistant turn 3' },
      { role: 'user', content: 'User turn 4' },
      { role: 'assistant', content: 'Assistant turn 5' },
      { role: 'user', content: 'User turn 6' },
      { role: 'assistant', content: 'Assistant turn 7' },
    ];

    manager.importHistory(complexHistory);
    // Prune should run during import
    const history = manager.exportHistory();
    // Verify that the first message is indeed a user message
    assert.equal(history[0].role, 'user');
  });
});
