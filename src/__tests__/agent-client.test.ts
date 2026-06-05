import { test } from 'node:test';
import * as assert from 'node:assert';
import { AgentClient } from '../agent/agent-client.js';

test('AgentClient Tests', async (t) => {
  const originalFetch = global.fetch;

  await t.test('chat sends request and parses response', async () => {
    let calledUrl = '';
    let calledOptions: any = null;

    global.fetch = async (url, options) => {
      calledUrl = url.toString();
      calledOptions = options;
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'Mock response' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      }), { status: 200 });
    };

    try {
      const client = new AgentClient('test-key', 'https://custom.api.com');
      const response = await client.chat([{ role: 'user', content: 'hello' }], 'gpt-4o');
      assert.equal(response.content, 'Mock response');
      assert.equal(calledUrl, 'https://custom.api.com/chat/completions');
      assert.ok(calledOptions.headers['Authorization'].includes('test-key'));
    } finally {
      global.fetch = originalFetch;
    }
  });

  await t.test('chat retries on 503 error', async () => {
    let callCount = 0;
    global.fetch = async (url, options) => {
      callCount++;
      if (callCount === 1) {
        return new Response('Service Unavailable', { status: 503 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'Success after retry' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      }), { status: 200 });
    };

    try {
      const client = new AgentClient('test-key', 'https://custom.api.com');
      const response = await client.chat([{ role: 'user', content: 'hello' }], 'gpt-4o');
      assert.equal(response.content, 'Success after retry');
      assert.equal(callCount, 2);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await t.test('chatStream processes SSE stream events correctly', async () => {
    global.fetch = async (url, options) => {
      const mockBody = {
        getReader() {
          let chunkIndex = 0;
          const chunks = [
            new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'),
            new TextEncoder().encode('data: {"choices":[{"delta":{"content":" world"}}]}\n\n'),
            new TextEncoder().encode('data: [DONE]\n\n')
          ];
          return {
            async read() {
              if (chunkIndex < chunks.length) {
                return { done: false, value: chunks[chunkIndex++] };
              }
              return { done: true, value: undefined };
            }
          };
        }
      };

      const response = new Response(null, { status: 200 });
      Object.defineProperty(response, 'body', { value: mockBody });
      return response;
    };

    try {
      const client = new AgentClient('test-key', 'https://custom.api.com');
      const generator = client.chatStream([{ role: 'user', content: 'hello' }], 'gpt-4o');
      
      const parts: string[] = [];
      for await (const chunk of generator) {
        if (chunk.type === 'content' && chunk.content) {
          parts.push(chunk.content);
        }
      }

      assert.deepEqual(parts, ['Hello', ' world']);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await t.test('ping returns true on 200 status', async () => {
    global.fetch = async (url, options) => {
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
    };

    try {
      const client = new AgentClient('test-key', 'https://custom.api.com');
      const pingRes = await client.ping();
      assert.equal(pingRes, true);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await t.test('chatStream propagates mid-stream JSON error', async () => {
    global.fetch = async (url, options) => {
      const mockBody = {
        getReader() {
          let chunkIndex = 0;
          const chunks = [
            new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'),
            new TextEncoder().encode('data: {"error":{"message":"Stream interrupted", "type":"stream_error"}}\n\n'),
            new TextEncoder().encode('data: [DONE]\n\n')
          ];
          return {
            async read() {
              if (chunkIndex < chunks.length) {
                return { done: false, value: chunks[chunkIndex++] };
              }
              return { done: true, value: undefined };
            }
          };
        }
      };

      const response = new Response(null, { status: 200 });
      Object.defineProperty(response, 'body', { value: mockBody });
      return response;
    };

    try {
      const client = new AgentClient('test-key', 'https://custom.api.com');
      const generator = client.chatStream([{ role: 'user', content: 'hello' }], 'gpt-4o');
      
      const parts: string[] = [];
      let threw = false;
      try {
        for await (const chunk of generator) {
          if (chunk.type === 'content' && chunk.content) {
            parts.push(chunk.content);
          }
        }
      } catch (err: any) {
        threw = true;
        assert.ok(err.message.includes('Stream error: Stream interrupted'));
      }

      assert.equal(threw, true);
      assert.deepEqual(parts, ['Hello']);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await t.test('chatStream does not retry after yielding chunks', async () => {
    let callCount = 0;
    global.fetch = async (url, options) => {
      callCount++;
      if (callCount === 1) {
        const mockBody = {
          getReader() {
            let chunkIndex = 0;
            const chunks = [
              new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'),
            ];
            return {
              async read() {
                if (chunkIndex < chunks.length) {
                  return { done: false, value: chunks[chunkIndex++] };
                }
                throw new Error('Network disconnect mid-stream');
              }
            };
          }
        };

        const response = new Response(null, { status: 200 });
        Object.defineProperty(response, 'body', { value: mockBody });
        return response;
      }
      
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'Success after retry' } }]
      }), { status: 200 });
    };

    try {
      const client = new AgentClient('test-key', 'https://custom.api.com');
      const generator = client.chatStream([{ role: 'user', content: 'hello' }], 'gpt-4o');
      
      const parts: string[] = [];
      let threw = false;
      try {
        for await (const chunk of generator) {
          if (chunk.type === 'content' && chunk.content) {
            parts.push(chunk.content);
          }
        }
      } catch (err: any) {
        threw = true;
        assert.ok(err.message.includes('Network disconnect mid-stream'));
      }

      assert.equal(threw, true);
      assert.equal(callCount, 1);
      assert.deepEqual(parts, ['Hello']);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
