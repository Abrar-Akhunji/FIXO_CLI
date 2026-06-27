/**
 * task-router.test.ts — Phase 2.1 acceptance test.
 *
 * Proves the new {@link routeAndExecute} dispatch:
 *   1. Simple input → invokes the supplied SingleAgent and returns
 *      `route: 'simple'`; both lifecycle hooks fire exactly once,
 *      `agent.reset()` is called.
 *   2. Complex input → takes the complex path (route: 'complex')
 *      WITHOUT touching the supplied SingleAgent. When the
 *      Orchestrator can't reach a real provider (default in a
 *      hermetic test) the call resolves with `success: false`, not
 *      a thrown exception — that's the production behaviour the
 *      pre-extraction inline code preserved via its catch block.
 *
 * These cases run independently of any TUI — satisfying the Phase
 * 2 acceptance gate in the remediation PRD.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { routeAndExecute, type RouteDeps } from '../agent/task-router.js';
import type { AgentContext, AgentResult } from '../types.js';
import type { SingleAgent } from '../agent/single-agent.js';
import type { ConversationManager } from '../agent/conversation.js';
import type { Interface as ReadlineInterface } from 'node:readline';

function mkSandbox(): { cwd: string; restore: () => void } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fixo-task-router-'));
  const originalHome = process.env.HOME;
  process.env.HOME = cwd;
  return {
    cwd,
    restore: () => {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

function makeStubAgent(stubResult: AgentResult): {
  agent: SingleAgent;
  callCount: () => number;
  resetCount: () => number;
} {
  let runCalls = 0;
  let resetCalls = 0;
  const stub = {
    runStreaming: async () => {
      runCalls += 1;
      return stubResult;
    },
    reset: () => { resetCalls += 1; },
    getClient: () => { throw new Error('stub: getClient not implemented'); },
    abort: () => { /* noop */ },
  };
  return {
    agent: stub as unknown as SingleAgent,
    callCount: () => runCalls,
    resetCount: () => resetCalls,
  };
}

function makeDeps(agent: SingleAgent, overrides: Partial<RouteDeps> = {}): RouteDeps {
  const conversation = {
    addTurn: () => {},
    getMessages: () => [],
  } as unknown as ConversationManager;
  const rl = {
    question: (query: string, cb: (ans: string) => void) => cb('y'),
  } as unknown as ReadlineInterface;
  return {
    agent,
    conversation,
    rl,
    verbose: false,
    ...overrides,
  };
}

function makeContext(cwd: string, task: string): AgentContext {
  return {
    task,
    model: 'gpt-4o-mini',
    cwd,
    verbose: false,
    selectedFiles: [],
    policy: 'shell-confirm',
    mode: 'BUILD',
  };
}

test('routeAndExecute — simple input dispatches to SingleAgent and reports route: simple', async () => {
  const ctx = mkSandbox();
  try {
    const stubResult: AgentResult = {
      success: true,
      response: 'done',
      modifiedFiles: [],
      tokensUsed: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      toolCallCount: 0,
      durationMs: 5,
      model: 'gpt-4o-mini',
    };
    const stub = makeStubAgent(stubResult);
    let startHookCalls = 0;
    let endHookCalls = 0;
    const deps = makeDeps(stub.agent, {
      onSimplePathStart: () => { startHookCalls += 1; },
      onSimplePathEnd: () => { endHookCalls += 1; },
    });

    const out = await routeAndExecute('fix the typo in foo.ts', makeContext(ctx.cwd, 'fix the typo in foo.ts'), deps);

    assert.equal(out.route, 'simple');
    assert.equal(out.result, stubResult, 'stub result must propagate unchanged');
    assert.equal(stub.callCount(), 1, 'agent.runStreaming must be called exactly once');
    assert.equal(stub.resetCount(), 1, 'agent.reset must be called exactly once');
    assert.equal(startHookCalls, 1, 'onSimplePathStart must fire exactly once');
    assert.equal(endHookCalls, 1, 'onSimplePathEnd must fire exactly once');
  } finally {
    ctx.restore();
  }
});

test('routeAndExecute — complex input takes complex path WITHOUT touching the simple-path agent', async () => {
  const ctx = mkSandbox();
  try {
    const stubResult: AgentResult = {
      success: true,
      response: 'should not be returned',
      modifiedFiles: [],
      tokensUsed: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      toolCallCount: 0,
      durationMs: 0,
    };
    const stub = makeStubAgent(stubResult);
    let startHookCalls = 0;
    let endHookCalls = 0;
    const deps = makeDeps(stub.agent, {
      onSimplePathStart: () => { startHookCalls += 1; },
      onSimplePathEnd: () => { endHookCalls += 1; },
    });

    const out = await routeAndExecute(
      'refactor the entire auth system across the codebase',
      makeContext(ctx.cwd, 'refactor the entire auth system across the codebase'),
      deps,
    );

    assert.equal(out.route, 'complex');
    assert.equal(out.result.success, false, 'orchestrator failure must surface as success: false');
    assert.match(out.result.response, /failed/i, 'response must explain the failure');
    assert.equal(stub.callCount(), 0, 'complex path must NOT invoke the simple-path agent');
    assert.equal(stub.resetCount(), 0, 'complex path must NOT reset the simple-path agent');
    assert.equal(startHookCalls, 0, 'onSimplePathStart must not fire on complex path');
    assert.equal(endHookCalls, 0, 'onSimplePathEnd must not fire on complex path');
  } finally {
    ctx.restore();
  }
});

test('routeAndExecute — simple-path errors do not skip onSimplePathEnd or agent.reset', async () => {
  const ctx = mkSandbox();
  try {
    let resetCalls = 0;
    let endHookCalls = 0;
    const failingAgent = {
      runStreaming: async () => { throw new Error('boom'); },
      reset: () => { resetCalls += 1; },
      getClient: () => { throw new Error('stub'); },
      abort: () => { /* noop */ },
    };
    const deps = makeDeps(failingAgent as unknown as SingleAgent, {
      onSimplePathEnd: () => { endHookCalls += 1; },
    });

    await assert.rejects(
      () => routeAndExecute('fix typo', makeContext(ctx.cwd, 'fix typo'), deps),
      /boom/,
    );
    assert.equal(resetCalls, 1, 'agent.reset must fire even when runStreaming throws');
    assert.equal(endHookCalls, 1, 'onSimplePathEnd must fire even when runStreaming throws');
  } finally {
    ctx.restore();
  }
});
