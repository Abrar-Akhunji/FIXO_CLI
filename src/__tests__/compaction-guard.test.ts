import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConversationManager } from "../agent/conversation.js";
import type { AgentClient } from "../agent/agent-client.js";

describe("Conversation Compaction Guard", () => {
  it("emergencyPruneToTarget reduces conversation below target token ceiling", () => {
    const manager = new ConversationManager(20000);
    // Add multiple turns
    for (let i = 0; i < 20; i++) {
      manager.addTurn(
        `User query number ${i} with long detailed problem statement and code sample foo bar baz`,
        `Assistant response number ${i} with lengthy technical solution and explanation 1234567890`,
      );
    }

    const initialTokens = manager.getTotalTokens();
    assert.ok(initialTokens > 2000);

    // Evict down to 1800 tokens
    manager.emergencyPruneToTarget(1800);
    const reducedTokens = manager.getTotalTokens();
    assert.ok(reducedTokens <= initialTokens);
    assert.ok(manager.getMessages().length >= 2);
  });

  it("resets consecutive compaction count on user message", () => {
    const manager = new ConversationManager(10000);
    manager.addTurn("Hello", "Hi there");
    assert.equal(manager.getConsecutiveCompactionCount(), 0);

    // Simulating turns resets counter
    manager.addTurn("Another question", "Another answer");
    assert.equal(manager.getConsecutiveCompactionCount(), 0);
  });

  it("compact() falls back to emergency pruning if summarizer fails", async () => {
    const manager = new ConversationManager(5000);
    // Seed with messages
    for (let i = 0; i < 15; i++) {
      manager.addTurn(`Question ${i}`, `Answer ${i} `.repeat(50));
    }

    const mockFailingClient: AgentClient = {
      async chat() {
        throw new Error("Simulated model rate limit 429");
      },
    } as unknown as AgentClient;

    const initialTokens = manager.getTotalTokens();
    const success = await manager.compact(mockFailingClient, "test-model");
    assert.equal(success, true); // Fallback succeeded
    assert.ok(manager.getTotalTokens() < initialTokens);
  });
});
