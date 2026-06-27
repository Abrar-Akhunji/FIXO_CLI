import { execFileSync } from 'child_process';
import type { AgentClient } from '../agent/agent-client.js';

function runGit(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (error: unknown) {
    const err = error as { stderr?: string; message?: string };
    const stderr = err.stderr?.trim() || err.message || String(error);
    throw new Error(`Git error (git ${args.join(' ')}): ${stderr}`);
  }
}

export function createBranch(cwd: string, branchName: string): string {
  runGit(cwd, ['checkout', '-b', branchName]);
  return `Successfully created and checked out branch: ${branchName}`;
}

export function commitChanges(cwd: string, message: string): string {
  runGit(cwd, ['add', '-A']);
  runGit(cwd, ['commit', '-m', message]);
  const hash = runGit(cwd, ['rev-parse', '--short', 'HEAD']);
  return `Successfully committed changes as ${hash}`;
}

export function pushBranch(cwd: string, remote: string = 'origin'): string {
  const currentBranch = runGit(cwd, ['branch', '--show-current']);
  if (!currentBranch) {
    throw new Error('Not currently on any branch (detached HEAD?)');
  }
  runGit(cwd, ['push', '-u', remote, currentBranch]);
  return `Successfully pushed branch ${currentBranch} to ${remote}`;
}

export async function generatePrDescription(
  cwd: string,
  client: AgentClient,
  model: string,
  baseBranch: string = 'main'
): Promise<{ title: string; body: string }> {
  const currentBranch = runGit(cwd, ['branch', '--show-current']);
  let diff = '';
  try {
    diff = runGit(cwd, ['diff', `${baseBranch}...${currentBranch}`]);
  } catch {
    // Fallback to local diff against HEAD~1 if comparison fails
    try {
      diff = runGit(cwd, ['diff', 'HEAD~1']);
    } catch {
      diff = runGit(cwd, ['diff']);
    }
  }

  // Max diff size to send to model is 40k chars (~10k tokens)
  if (diff.length > 40_000) {
    diff = diff.slice(0, 40_000) + '\n\n... (diff truncated for length)';
  }

  if (!diff.trim()) {
    return {
      title: `work on ${currentBranch}`,
      body: `Automated PR description for branch ${currentBranch}. No changes detected in comparison to ${baseBranch}.`
    };
  }

  const systemPrompt = `You are a pull request description generator. Given the git diff of changes, write a clean, detailed semantic PR description.
Your output must be a single valid JSON object matching this schema with NO markdown formatting, NO backticks, and NO conversational text:
{
  "title": "concise semantic PR title",
  "body": "detailed markdown body containing: summary of changes, motivation, and tests completed."
}`;

  try {
    const response = await client.chat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Here is the diff:\n\n${diff}` }
      ],
      model,
      { agent_task_type: 'investigation', required_capabilities: ['fast'] }
    );

    const content = response.content?.trim() || '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content);
    if (parsed && typeof parsed.title === 'string' && typeof parsed.body === 'string') {
      return parsed;
    }
  } catch (err) {
    // Fallback on error
  }

  return {
    title: `updates on branch ${currentBranch}`,
    body: `## Summary\nAutomated updates on branch ${currentBranch}.\n\n## Changes\n- Code modifications applied by FixO.`
  };
}

export async function createPullRequest(
  cwd: string,
  client: AgentClient,
  model: string,
  baseBranch: string = 'main'
): Promise<string> {
  const currentBranch = runGit(cwd, ['branch', '--show-current']);
  if (!currentBranch || currentBranch === 'main' || currentBranch === 'master') {
    throw new Error(`Cannot create pull request from branch "${currentBranch}"`);
  }

  // 1. Generate title and body
  const { title, body } = await generatePrDescription(cwd, client, model, baseBranch);

  // 2. Check if GitHub CLI is installed and try to run it
  try {
    const ghCheck = execFileSync('which', ['gh'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (ghCheck) {
      const prUrl = execFileSync(
        'gh',
        ['pr', 'create', '--base', baseBranch, '--head', currentBranch, '--title', title, '--body', body],
        { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
      return `Pull request created successfully via GitHub CLI:\n${prUrl}`;
    }
  } catch {
    // GitHub CLI not found or failed (not logged in, etc.)
  }

  // 3. Fallback: Generate comparison URL
  let remoteUrl = '';
  try {
    remoteUrl = runGit(cwd, ['remote', 'get-url', 'origin']);
  } catch {
    // No remote
  }

  let webUrl = '';
  if (remoteUrl) {
    // Parse git@github.com:owner/repo.git or https://github.com/owner/repo.git
    let cleanUrl = remoteUrl;
    if (cleanUrl.startsWith('git@')) {
      cleanUrl = cleanUrl.replace(':', '/').replace('git@', 'https://');
    }
    if (cleanUrl.endsWith('.git')) {
      cleanUrl = cleanUrl.slice(0, -4);
    }
    const titleEscaped = encodeURIComponent(title);
    const bodyEscaped = encodeURIComponent(body);
    webUrl = `${cleanUrl}/compare/${baseBranch}...${currentBranch}?expand=1&title=${titleEscaped}&body=${bodyEscaped}`;
  }

  return [
    `GitHub CLI (gh) was not found or not authenticated. Here is the generated PR details:`,
    `\nPR Title: ${title}`,
    `\nPR Body:\n${body}`,
    webUrl ? `\nYou can create the pull request manually by opening this URL in your browser:\n${webUrl}` : ''
  ].filter(Boolean).join('\n');
}
