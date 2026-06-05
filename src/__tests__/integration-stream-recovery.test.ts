import assert from 'node:assert/strict';
import test from 'node:test';
import type { StreamChunk } from '../agent/agent-client.js';
import { AgentClient } from '../agent/agent-client.js';
import { StreamResumeExhaustedError } from '../agent/stream-glue.js';

interface ScriptedResponse {
  /** When this script step runs, what should the mock fetch do? */
  action: 'stream' | 'throw' | 'cut' | 'http-error';
  /** Chunks to emit on a 'stream' / first N chunks before a 'cut'. */
  chunks?: StreamChunk[];
  /** Error message for 'throw'. */
  message?: string;
  /** HTTP status for 'http-error'. */
  status?: number;
  /** Whether the chunk emitted right before the cut is a tool call. */
  cutDuringToolCall?: boolean;
}

interface MockState {
  calls: number;
  bodies: string[];
}

function makeSseBody(chunks: StreamChunk[]): string {
  // Render chunks as OpenAI-compatible SSE frames.
  return chunks
    .map((c) => {
      const payload =
        c.type === 'content'
          ? { choices: [{ delta: { content: c.content } }] }
          : c.type === 'thinking'
            ? { choices: [{ delta: { reasoning_content: c.thinking } }] }
            : c.type === 'done'
              ? '[DONE]'
              : { choices: [{ delta: { tool_calls: [c.tool_call] } }] };
      return typeof payload === 'string'
        ? `data: ${payload}\n\n`
        : `data: ${JSON.stringify(payload)}\n\n`;
    })
    .join('');
}

async function readChunksFromResponse(response: Response): Promise<StreamChunk[]> {
  const reader = response.body?.getReader();
  if (!reader) return [];
  const decoder = new TextDecoder();
  const out: StreamChunk[] = [];
  // Drain the body fully so the response stream closes and the
  // consumer's `for await` loop completes.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    decoder.decode(value, { stream: true });
  }
  return out;
}

function installFetchStub(script: ScriptedResponse[]): MockState {
  const state: MockState = { calls: 0, bodies: [] };
  const realFetch = globalThis.fetch;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = async (input: unknown, init?: { body?: unknown }): Promise<Response> => {
    state.calls += 1;
    if (init?.body) state.bodies.push(String(init.body));

    const step = script[Math.min(state.calls - 1, script.length - 1)];
    if (!step) {
      throw new Error('mock fetch script exhausted');
    }

    if (step.action === 'throw') {
      throw new Error(step.message ?? 'simulated network failure');
    }
    if (step.action === 'http-error') {
      return new Response(`{"error":"${step.message ?? 'http error'}"}`, {
        status: step.status ?? 500,
        headers: { 'content-type': 'application/json' },
      });
    }

    const chunks = step.chunks ?? [];
    const body = makeSseBody(chunks);

    if (step.action === 'cut') {
      // Produce a streaming response that yields all configured chunks
      // and then errors out on the NEXT `reader.read()`. The consumer's
      // `for await` loop catches the error AFTER having already yielded
      // the chunks it received — which is exactly the situation
      // `chatStreamWithResume` is designed to recover from.
      const encoder = new TextEncoder();
      const partial = makeSseBody(chunks);
      const partialBytes = encoder.encode(partial);
      let emitted = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!emitted) {
            emitted = true;
            controller.enqueue(partialBytes);
            return;
          }
          // Second pull: simulate the socket going away mid-stream.
          controller.error(new Error('socket hang up'));
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }

    // Plain 'stream' action: full response.
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };

  // Stash the original fetch on the state for restoration.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (state as any)._restore = (): void => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = realFetch;
  };
  return state;
}

function restoreFetch(state: MockState): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (state as any)._restore();
}

function makeClient(): AgentClient {
  return new AgentClient('test-key', 'http://localhost:0', false);
}

test('chatStreamWithResume transparently re-issues the request after a mid-stream cut', async () => {
  const state = installFetchStub([
    {
      action: 'cut',
      chunks: [
        { type: 'content', content: 'Hello ' },
        { type: 'content', content: 'world' },
      ],
    },
    {
      action: 'stream',
      chunks: [
        { type: 'content', content: 'again' },
        { type: 'done', usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } },
      ],
    },
  ]);
  const client = makeClient();

  try {
    const collected: string[] = [];
    let resumedSeenDone = false;
    for await (const chunk of client.chatStreamWithResume(
      [{ role: 'user', content: 'hi' }],
      'auto',
      {},
      3,
    )) {
      if (chunk.type === 'content' && typeof chunk.content === 'string') {
        collected.push(chunk.content);
      }
      if (chunk.type === 'done') resumedSeenDone = true;
    }
    // The consumer should have seen content from BOTH attempts glued
    // together; the resume was invisible to the for-await loop.
    assert.deepEqual(collected, ['Hello ', 'world', 'again']);
    assert.equal(resumedSeenDone, true);
    assert.equal(state.calls, 2);
    // The second request body must contain the partial text from the first.
    const secondBody = state.bodies[1] ?? '';
    assert.match(secondBody, /Hello world/);
    assert.match(secondBody, /STREAM RESUMED/);
  } finally {
    restoreFetch(state);
  }
});

test('chatStreamWithResume stops after maxResumeAttempts and throws StreamResumeExhaustedError', async () => {
  const state = installFetchStub([
    { action: 'cut', chunks: [{ type: 'content', content: 'a' }] },
    { action: 'cut', chunks: [{ type: 'content', content: 'b' }] },
    { action: 'cut', chunks: [{ type: 'content', content: 'c' }] },
    { action: 'cut', chunks: [{ type: 'content', content: 'd' }] },
  ]);
  const client = makeClient();

  try {
    await assert.rejects(
      (async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of client.chatStreamWithResume(
          [{ role: 'user', content: 'x' }],
          'auto',
          {},
          2, // cap at 2 resume attempts
        )) {
          // drain
        }
      })(),
      (err: unknown) => {
        assert.ok(err instanceof StreamResumeExhaustedError);
        const e = err as StreamResumeExhaustedError;
        assert.match(e.message, /exhausted/);
        return true;
      },
    );
    // 1 initial attempt + 2 resume attempts = 3 calls.
    assert.equal(state.calls, 3);
  } finally {
    restoreFetch(state);
  }
});

test('chatStreamWithResume propagates a non-resumable error without retrying', async () => {
  const state = installFetchStub([
    { action: 'http-error', status: 413, message: 'context too large' },
  ]);
  const client = makeClient();

  try {
    await assert.rejects(
      (async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of client.chatStreamWithResume(
          [{ role: 'user', content: 'x' }],
          'auto',
          {},
          3,
        )) {
          // drain
        }
      })(),
      /Context too large/,
    );
    // 413 fires before any chunk is yielded — chatStreamWithResume
    // must NOT attempt a resume; the call count stays at 1.
    assert.equal(state.calls, 1);
  } finally {
    restoreFetch(state);
  }
});

test('chatStreamWithResume throws StreamResumeExhaustedError when the cut happens inside a tool call', async () => {
  const state = installFetchStub([
    {
      action: 'cut',
      chunks: [
        { type: 'content', content: 'I will read the file:\n' },
        {
          type: 'tool_call_start',
          tool_call: { index: 0, id: 't1', function: { name: 'read_file' } },
        },
        { type: 'tool_call_delta', tool_call: { index: 0, function: { arguments: '{"pat' } } },
      ],
      cutDuringToolCall: true,
    },
  ]);
  const client = makeClient();

  try {
    await assert.rejects(
      (async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of client.chatStreamWithResume(
          [{ role: 'user', content: 'x' }],
          'auto',
          {},
          3,
        )) {
          // drain
        }
      })(),
      (err: unknown) => {
        assert.ok(err instanceof StreamResumeExhaustedError);
        const e = err as StreamResumeExhaustedError;
        assert.equal(e.context.cutDuringToolCall, true);
        assert.equal(e.context.partial, 'I will read the file:\n');
        return true;
      },
    );
    // Only the original attempt was made — no resume after a tool-call cut.
    assert.equal(state.calls, 1);
  } finally {
    restoreFetch(state);
  }
});

test('chatStreamWithResume propagates pre-stream errors (no chunks yielded) unchanged', async () => {
  const state = installFetchStub([
    { action: 'http-error', status: 413, message: 'context too large' },
  ]);
  const client = makeClient();

  try {
    await assert.rejects(
      (async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of client.chatStreamWithResume(
          [{ role: 'user', content: 'x' }],
          'auto',
          {},
          3,
        )) {
          // drain
        }
      })(),
      /Context too large/,
    );
    assert.equal(state.calls, 1);
  } finally {
    restoreFetch(state);
  }
});

// Reference unused helpers to keep them available for future test cases.
void readChunksFromResponse;
