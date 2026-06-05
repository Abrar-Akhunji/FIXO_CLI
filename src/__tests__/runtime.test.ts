import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorkspaceGuard } from '../workspace-guard.js';
import { classifyCommand } from '../runtime/policy.js';
import { TaskSession, undoRun } from '../runtime/task-session.js';
import { createStructuredPlan, validatePlan, classifyComplexityHeuristic } from '../planner.js';
import { buildIndex, findCodebaseDependencies } from '../indexer.js';
import { WorkspaceLockManager } from '../workspace-lock.js';

test('WorkspaceGuard rejects sibling-prefix escapes', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'fixo-guard-'));
  const root = path.join(parent, 'cli');
  const sibling = path.join(parent, 'cli-malicious');
  fs.mkdirSync(root);
  fs.mkdirSync(sibling);
  const guard = new WorkspaceGuard(root);

  assert.equal(guard.isInside(path.join(root, 'file.ts')), true);
  assert.equal(guard.isInside(path.join(sibling, 'file.ts')), false);
  assert.throws(() => guard.resolve('../cli-malicious/file.ts'));
});

test('command classifier marks safe checks and high-risk shell forms', () => {
  assert.equal(classifyCommand('npm run build:cli'), 'low');
  assert.equal(classifyCommand('git status --short'), 'low');
  assert.equal(classifyCommand('rm -rf ./dist'), 'high');
  assert.equal(classifyCommand('echo hi | sh'), 'high');
});

test('TaskSession undo restores changed files and deletes created files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fixo-run-'));
  const existing = path.join(root, 'existing.txt');
  const created = path.join(root, 'created.txt');
  fs.writeFileSync(existing, 'before', 'utf-8');

  const session = new TaskSession({ cwd: root, task: 'test rollback', model: 'auto' });
  session.noteRead(existing);
  session.captureBefore(existing);
  fs.writeFileSync(existing, 'after', 'utf-8');
  session.noteChange(existing);
  session.captureBefore(created);
  fs.writeFileSync(created, 'new', 'utf-8');
  session.noteChange(created);
  session.finish('success', 'done');

  const result = undoRun(root, session.id);
  assert.match(result, /Undid 2 file change/);
  assert.equal(fs.readFileSync(existing, 'utf-8'), 'before');
  assert.equal(fs.existsSync(created), false);
});

test('planner creates and validates structured plans', () => {
  const plan = createStructuredPlan('refactor the user validation in auth.ts');
  assert.equal(plan.taskType, 'refactor');
  assert.equal(validatePlan(plan), true);
  assert.equal(validatePlan({}), false);
});

test('indexer maps imports, dependents, and calculates PageRank importance', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fixo-indexer-'));
  const fileA = path.join(root, 'fileA.ts');
  const fileB = path.join(root, 'fileB.ts');
  
  // fileB imports fileA
  fs.writeFileSync(fileA, 'export const a = 1;', 'utf-8');
  fs.writeFileSync(fileB, 'import { a } from "./fileA.js";', 'utf-8');
  
  const index = await buildIndex(root);
  assert.equal(index.files.length, 2);
  
  const indexedA = index.files.find(f => f.path === 'fileA.ts');
  const indexedB = index.files.find(f => f.path === 'fileB.ts');
  
  assert.ok(indexedA);
  assert.ok(indexedB);
  
  // fileB imports fileA
  assert.deepEqual(indexedB.resolvedImports, ['fileA.ts']);
  // fileA is imported by fileB
  assert.deepEqual(indexedA.dependents, ['fileB.ts']);
  
  // PageRank: A should have higher importance than B because B imports A
  assert.ok((indexedA.importance || 0) > (indexedB.importance || 0));
  
  const depsReport = await findCodebaseDependencies(root, 'fileA.ts');
  assert.match(depsReport, /Direct Dependents/);
  assert.match(depsReport, /fileB.ts/);
});

test('WorkspaceLockManager enforces shared read and exclusive write locks', () => {
  const manager = new WorkspaceLockManager();
  const file = 'src/ui/prompt.ts';

  // Agent 1 acquires read lock
  assert.equal(manager.acquireLock(file, 'agent-1', 'read'), true);
  // Agent 2 acquires read lock (shared)
  assert.equal(manager.acquireLock(file, 'agent-2', 'read'), true);
  
  // Agent 3 fails to acquire write lock (blocked by read locks)
  assert.equal(manager.acquireLock(file, 'agent-3', 'write'), false);
  assert.equal(manager.isLocked(file, 'write'), true);
  
  // Release Agent 2 read lock
  assert.equal(manager.releaseLock(file, 'agent-2'), true);
  
  // Agent 1 upgrades read to write lock (allowed because agent-1 is the only reader now)
  assert.equal(manager.acquireLock(file, 'agent-1', 'write'), true);
  
  // Agent 2 now fails to acquire read lock (blocked by agent-1 write lock)
  assert.equal(manager.acquireLock(file, 'agent-2', 'read'), false);
  
  // Release all locks for Agent 1
  manager.releaseAllLocks('agent-1');
  
  // File should be fully unlocked now
  assert.equal(manager.isLocked(file, 'read'), false);
  assert.equal(manager.isLocked(file, 'write'), false);
});

test('classifyComplexityHeuristic detects simple and complex tasks', () => {
  // Simple chat and trivial queries
  assert.equal(classifyComplexityHeuristic('hi').complexity, 'simple');
  assert.equal(classifyComplexityHeuristic('explain how this database works').complexity, 'simple');
  
  // Single file edits are simple
  assert.equal(classifyComplexityHeuristic('add input validation in src/auth.ts').complexity, 'simple');
  
  // Multiple files are complex
  assert.equal(classifyComplexityHeuristic('modify src/auth.ts and src/db.ts to support dynamic sessions').complexity, 'complex');
  
  // Complexity keywords are complex
  assert.equal(classifyComplexityHeuristic('refactor the entire codebase for parallel orchestration').complexity, 'complex');
});

import { McpClient } from '../agent/mcp-client.js';

test('McpClient communication via stdio JSON-RPC', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fixo-mcp-'));
  const serverScript = path.join(root, 'server.js');
  const serverCode = `
import readline from 'readline';
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});
rl.on('line', (line) => {
  try {
    const req = JSON.parse(line);
    if (req.method === 'initialize') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: req.id,
        result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'mock-server', version: '1.0.0' } }
      }) + '\\n');
    } else if (req.method === 'tools/list') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          tools: [
            {
              name: 'hello_world',
              description: 'Say hello',
              inputSchema: {
                type: 'object',
                properties: {
                  name: { type: 'string' }
                },
                required: ['name']
              }
            }
          ]
        }
      }) + '\\n');
    } else if (req.method === 'tools/call') {
      const name = req.params.arguments.name || 'world';
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          content: [
            {
              type: 'text',
              text: \`Hello, \${name}!\`
            }
          ]
        }
      }) + '\\n');
    }
  } catch (e) {
    // ignore
  }
});
`;
  fs.writeFileSync(serverScript, serverCode, 'utf-8');

  const client = new McpClient('mock-server', {
    command: 'node',
    args: [serverScript],
  });

  const started = await client.start();
  assert.equal(started, true);

  const tools = await client.listTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'hello_world');

  const callResult = await client.callTool('hello_world', { name: 'FixO' });
  assert.ok(callResult);
  assert.equal(callResult.content[0].text, 'Hello, FixO!');

  client.stop();
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {}
});

import { execSync } from 'child_process';
import { createBranch, commitChanges } from '../git/git-ops.js';

test('Git-Ops branch creation and commit operations', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fixo-git-ops-'));
  
  // Initialize repository
  execSync('git init -b main', { cwd: root, stdio: 'ignore' });
  execSync('git config user.email "test@example.com"', { cwd: root, stdio: 'ignore' });
  execSync('git config user.name "Test User"', { cwd: root, stdio: 'ignore' });
  
  // Create initial commit (required so checkout -b works)
  fs.writeFileSync(path.join(root, 'readme.md'), '# Initial', 'utf-8');
  execSync('git add readme.md', { cwd: root, stdio: 'ignore' });
  execSync('git commit -m "initial commit"', { cwd: root, stdio: 'ignore' });
  
  // Test createBranch
  const branchResult = createBranch(root, 'feature/test-branch');
  assert.match(branchResult, /feature\/test-branch/);
  
  const currentBranch = execSync('git branch --show-current', { cwd: root, encoding: 'utf-8' }).trim();
  assert.equal(currentBranch, 'feature/test-branch');
  
  // Test commitChanges
  fs.writeFileSync(path.join(root, 'readme.md'), '# Updated', 'utf-8');
  const commitResult = commitChanges(root, 'feat: update readme');
  assert.match(commitResult, /Successfully committed/);
  
  const commitLog = execSync('git log -1 --format=%s', { cwd: root, encoding: 'utf-8' }).trim();
  assert.equal(commitLog, 'feat: update readme');
  
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {}
});

import { Orchestrator } from '../agent/orchestrator.js';
import { AgentPool } from '../agent/agent-pool.js';
import type { TaskDAG, Subtask } from '../types.js';

test('Orchestrator validateAndSortDAG detects cycles and orders tasks', () => {
  const orchestrator = new Orchestrator();

  const subtasks: Subtask[] = [
    { id: 'T3', title: 'Task 3', description: 'desc', persona: 'test', dependencies: ['T2'], files: [], status: 'pending' },
    { id: 'T1', title: 'Task 1', description: 'desc', persona: 'code', dependencies: [], files: [], status: 'pending' },
    { id: 'T2', title: 'Task 2', description: 'desc', persona: 'code', dependencies: ['T1'], files: [], status: 'pending' }
  ];

  const sorted = orchestrator.validateAndSortDAG(subtasks);
  assert.equal(sorted.length, 3);
  assert.equal(sorted[0].id, 'T1');
  assert.equal(sorted[1].id, 'T2');
  assert.equal(sorted[2].id, 'T3');

  const cycleTasks: Subtask[] = [
    { id: 'T1', title: 'Task 1', description: 'desc', persona: 'code', dependencies: ['T2'], files: [], status: 'pending' },
    { id: 'T2', title: 'Task 2', description: 'desc', persona: 'code', dependencies: ['T1'], files: [], status: 'pending' }
  ];
  assert.throws(() => orchestrator.validateAndSortDAG(cycleTasks), /Circular dependency/);
});

test('AgentPool executes hardcoded DAG concurrently respecting dependencies', async () => {
  const pool = new AgentPool(2, 20);
  
  const executionOrder: string[] = [];
  
  (pool as any).worker = {
    run: async (context: any, subtask: Subtask, budgetDec: any) => {
      budgetDec();
      executionOrder.push(subtask.id);
      return {
        success: true,
        output: subtask.persona === 'reviewer' ? 'APPROVED' : `Completed ${subtask.id}`,
        tokensUsed: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        toolCallCount: 1
      };
    }
  };

  const dag: TaskDAG = {
    subtasks: [
      { id: 'T3', title: 'Task 3', description: 'desc', persona: 'reviewer', dependencies: ['T2'], files: [], status: 'pending' },
      { id: 'T1', title: 'Task 1', description: 'desc', persona: 'code', dependencies: [], files: [], status: 'pending' },
      { id: 'T2', title: 'Task 2', description: 'desc', persona: 'code', dependencies: ['T1'], files: [], status: 'pending' }
    ]
  };

  const success = await pool.execute({ cwd: '.', task: 'test', model: 'auto', verbose: false, selectedFiles: [] }, dag);
  assert.equal(success, true);
  assert.deepEqual(executionOrder, ['T1', 'T2', 'T3']);
  assert.equal(dag.subtasks.every(s => s.status === 'completed'), true);
  assert.equal(pool.tokensUsed.total_tokens, 45);
  assert.equal(pool.toolCallCount, 3);
});

test('AgentPool Reviewer Loop Integration schedules repair and follow-up review', async () => {
  const pool = new AgentPool(1, 10);
  let reviewCount = 0;

  (pool as any).worker = {
    run: async (context: any, subtask: Subtask, budgetDec: any) => {
      budgetDec();
      if (subtask.persona === 'reviewer') {
        reviewCount++;
        if (reviewCount === 1) {
          return {
            success: true,
            output: 'REJECTED: formatting issue',
            tokensUsed: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
            toolCallCount: 1
          };
        } else {
          return {
            success: true,
            output: 'APPROVED: looks good',
            tokensUsed: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
            toolCallCount: 1
          };
        }
      }
      return {
        success: true,
        output: `Fixed code for ${subtask.id}`,
        tokensUsed: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        toolCallCount: 1
      };
    }
  };

  const dag: TaskDAG = {
    subtasks: [
      { id: 'T1', title: 'Task 1', description: 'desc', persona: 'reviewer', dependencies: [], files: [], status: 'pending' }
    ]
  };

  const success = await pool.execute({ cwd: '.', task: 'test', model: 'auto', verbose: false, selectedFiles: [] }, dag);
  assert.equal(success, true);
  // Initial review (REJECTED) -> repair -> second review (APPROVED)
  assert.equal(reviewCount, 2);
  assert.equal(dag.subtasks.length, 3); // T1, repair task, follow-up reviewer task
  assert.equal(dag.subtasks.every(s => s.status === 'completed'), true);
});

test('AgentPool throws on global tool budget exhaustion', async () => {
  const pool = new AgentPool(1, 2); // Budget limit = 2

  (pool as any).worker = {
    run: async (context: any, subtask: Subtask, budgetDec: any) => {
      budgetDec(); // 1st tool call
      budgetDec(); // 2nd tool call
      budgetDec(); // 3rd tool call -> throws!
      return {
        success: true,
        output: 'Never reached',
        tokensUsed: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        toolCallCount: 3
      };
    }
  };

  const dag: TaskDAG = {
    subtasks: [
      { id: 'T1', title: 'Task 1', description: 'desc', persona: 'code', dependencies: [], files: [], status: 'pending' }
    ]
  };

  await assert.rejects(
    pool.execute({ cwd: '.', task: 'test', model: 'auto', verbose: false, selectedFiles: [] }, dag),
    /Global tool call budget of 2 exhausted/
  );
});

import { acquireLockWithRetryAndTimeout } from '../agent/worker-agent.js';

test('acquireLockWithRetryAndTimeout timing and retry limits', async () => {
  const mockLockManager = {
    locks: new Map<string, string>(),
    acquireLock(filePath: string, agentId: string, type: string) {
      const existing = this.locks.get(filePath);
      if (existing && existing !== agentId) {
        return false;
      }
      this.locks.set(filePath, agentId);
      return true;
    },
    releaseLock(filePath: string, agentId: string) {
      if (this.locks.get(filePath) === agentId) {
        this.locks.delete(filePath);
        return true;
      }
      return false;
    }
  };

  // Lock file by another agent
  mockLockManager.acquireLock('file.txt', 'other-agent', 'write');

  // Override setTimeout and Date.now to speed up test execution
  const originalNow = Date.now;
  let mockTime = originalNow();
  Date.now = () => mockTime;

  const originalSetTimeout = global.setTimeout;
  (global as any).setTimeout = (fn: any, delay: number) => {
    mockTime += delay; // advance mock clock by the delay amount!
    return originalSetTimeout(fn, 1);
  };

  try {
    const success = await acquireLockWithRetryAndTimeout(
      mockLockManager as any,
      ['file.txt'],
      'my-agent',
      'write'
    );
    // It should fail because the lock is held and we timed out
    assert.equal(success, false);
  } finally {
    global.setTimeout = originalSetTimeout;
    Date.now = originalNow;
  }
});

test('WorkspaceGuard symlink escape protection resolves real paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fixo-symlink-root-'));
  const guard = new WorkspaceGuard(root);

  // Normal file inside root
  const fileInside = path.join(root, 'inside.txt');
  assert.equal(guard.isInside(fileInside), true);

  // Path containing symlink pointing outside root
  const tempDirOutside = fs.mkdtempSync(path.join(os.tmpdir(), 'fixo-symlink-outside-'));
  const targetOutside = path.join(tempDirOutside, 'secret.txt');
  fs.writeFileSync(targetOutside, 'secret credentials', 'utf-8');

  const symlinkInside = path.join(root, 'malicious_link.txt');
  fs.symlinkSync(targetOutside, symlinkInside);

  // isInside should resolve the symlink and see it resolves to a path outside workspace root
  assert.equal(guard.isInside(symlinkInside), false);

  try {
    fs.unlinkSync(symlinkInside);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(tempDirOutside, { recursive: true, force: true });
  } catch {}
});

test('WorkspaceGuard ensureFile throws clean errors', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fixo-ensure-'));
  const guard = new WorkspaceGuard(root);

  assert.throws(
    () => guard.ensureFile('nonexistent.txt'),
    /File does not exist: nonexistent.txt/
  );

  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {}
});






