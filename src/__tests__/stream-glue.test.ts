import assert from 'node:assert/strict';
import test from 'node:test';
import type { StreamChunk } from '../agent/agent-client.js';
import {
  reconstructPartialResponse,
  isMidStreamResumable,
  StreamResumeExhaustedError,
  NonRetryableError,
} from '../agent/stream-glue.js';
import { HttpError } from '../agent/agent-client.js';

function content(text: string): StreamChunk {
  return { type: 'content', content: text };
}
function thinking(text: string): StreamChunk {
  return { type: 'thinking', thinking: text };
}
function toolStart(): StreamChunk {
  return { type: 'tool_call_start', tool_call: { index: 0, id: 't1' } };
}
function toolDelta(): StreamChunk {
  return { type: 'tool_call_delta', tool_call: { index: 0, function: { arguments: '{"p' } } };
}
function done(): StreamChunk {
  return { type: 'done' };
}

test('reconstructPartialResponse concatenates content chunks verbatim', () => {
  const chunks = [content('Hello '), content('world'), done()];
  assert.equal(reconstructPartialResponse(chunks), 'Hello world');
});

test('reconstructPartialResponse includes thinking blocks in order', () => {
  const chunks = [thinking('Let me think...'), content('Answer')];
  assert.equal(reconstructPartialResponse(chunks), 'Let me think...Answer');
});

test('reconstructPartialResponse stops at the first tool call and does not include it', () => {
  const chunks = [content('Here is the file:\n'), toolStart(), toolDelta(), done()];
  const out = reconstructPartialResponse(chunks);
  assert.equal(out, 'Here is the file:\n');
  assert.ok(!out.includes('tool'));
});

test('reconstructPartialResponse returns empty string for an empty or all-tool chunk list', () => {
  assert.equal(reconstructPartialResponse([]), '');
  assert.equal(reconstructPartialResponse([done()]), '');
  assert.equal(reconstructPartialResponse([toolStart()]), '');
});

test('reconstructPartialResponse handles thinking mixed with content', () => {
  const chunks = [
    thinking('Reasoning: '),
    content('first '),
    thinking('more reasoning '),
    content('second'),
  ];
  assert.equal(reconstructPartialResponse(chunks), 'Reasoning: first more reasoning second');
});

test('reconstructPartialResponse ignores done chunks but does not stop on them', () => {
  // `done` is metadata about the end-of-stream; reconstruction keeps
  // walking in case the consumer appended more content after a reset.
  const chunks = [content('a'), done(), content('b'), done()];
  assert.equal(reconstructPartialResponse(chunks), 'ab');
});

test('isMidStreamResumable returns false for AbortError', () => {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  assert.equal(isMidStreamResumable(err), false);
});

test('isMidStreamResumable returns false for NonRetryableError', () => {
  const err = new NonRetryableError('bad config');
  assert.equal(isMidStreamResumable(err), false);
});

test('isMidStreamResumable returns true for network errors', () => {
  for (const msg of ['ECONNRESET', 'ETIMEDOUT', 'fetch failed', 'socket hang up']) {
    const err = new Error(msg);
    assert.equal(isMidStreamResumable(err), true, `expected ${msg} to be resumable`);
  }
});

test('isMidStreamResumable returns true for TimeoutError by name', () => {
  const err = new Error('something timed out');
  err.name = 'TimeoutError';
  assert.equal(isMidStreamResumable(err), true);
});

test('isMidStreamResumable returns true for 5xx HttpError and 408/425', () => {
  for (const status of [408, 425, 500, 502, 503, 504]) {
    assert.equal(isMidStreamResumable(new HttpError(status, 'boom')), true, `status ${status}`);
  }
});

test('isMidStreamResumable returns false for non-retryable HttpError statuses', () => {
  for (const status of [400, 401, 403, 404, 413, 422, 429]) {
    assert.equal(isMidStreamResumable(new HttpError(status, 'boom')), false, `status ${status}`);
  }
});

test('isMidStreamResumable returns false for plain string errors', () => {
  assert.equal(isMidStreamResumable('just a string'), false);
  assert.equal(isMidStreamResumable(undefined), false);
  assert.equal(isMidStreamResumable(null), false);
});

test('StreamResumeExhaustedError carries structured context', () => {
  const chunks: StreamChunk[] = [content('partial ')];
  const err = new StreamResumeExhaustedError('cut during tool call', {
    resumeAttempt: 1,
    chunks,
    partial: 'partial ',
    cutDuringToolCall: true,
  });
  assert.equal(err.name, 'StreamResumeExhaustedError');
  assert.equal(err.context.resumeAttempt, 1);
  assert.equal(err.context.partial, 'partial ');
  assert.equal(err.context.cutDuringToolCall, true);
  assert.equal(err.context.chunks, chunks);
  assert.match(err.message, /cut during tool call/);
});

test('NonRetryableError preserves its cause', () => {
  const inner = new Error('original');
  const err = new NonRetryableError('wrapped', inner);
  assert.equal(err.name, 'NonRetryableError');
  assert.equal(err.cause, inner);
  assert.equal(err.message, 'wrapped');
});
