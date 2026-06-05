import { test } from 'node:test';
import * as assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SingleAgent } from '../agent/single-agent.js';
import { ConversationManager } from '../agent/conversation.js';
import type { AgentContext } from '../types.js';

test('SingleAgent execution loop integration', async (t) => {
  await t.test('runStreaming processes tool calls and final responses', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixo-agent-loop-'));
    const agent = new SingleAgent();
    const conversation = new ConversationManager();

    // Mock client.chat
    let chatCallCount = 0;
    const mockClient = {
      chat: async (messages: any, model: any, options: any) => {
        chatCallCount++;
        if (chatCallCount === 1) {
          // Return a tool call to write a file
          return {
            content: 'I need to write a file first.',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'write_file',
                  arguments: JSON.stringify({ path: 'output.txt', content: 'loop successful' })
                }
              }
            ],
            usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
            model: 'gemini-2.5-flash',
          };
        }
        // Second turn: Return assistant text final response
        return {
          content: 'Done writing the file.',
          tool_calls: [],
          usage: { prompt_tokens: 15, completion_tokens: 10, total_tokens: 25 },
          model: 'gemini-2.5-flash',
        };
      }
    };

    (agent as any).client = mockClient;

    const context: AgentContext = {
      task: 'Write a file output.txt with contents "loop successful"',
      model: 'auto',
      cwd: tempDir,
      verbose: false,
      selectedFiles: [],
      mode: 'BUILD',
      yes: true, // auto-approve tool calls
    };

    const result = await agent.runStreaming(context, conversation);
    
    assert.equal(result.success, true);
    assert.equal(chatCallCount, 2);
    assert.equal(result.model, 'gemini-2.5-flash');
    
    // Verify that output.txt was indeed created in tempDir
    const createdFile = path.join(tempDir, 'output.txt');
    assert.equal(fs.existsSync(createdFile), true);
    assert.equal(fs.readFileSync(createdFile, 'utf-8'), 'loop successful');
  });
});
