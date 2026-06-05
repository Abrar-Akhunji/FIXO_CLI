/**
 * Git integration manager for automated commits, undo, and diff viewing.
 * All git operations are safely sandboxed to the workspace directory.
 */
import { execFileSync } from 'child_process';
import { WorkspaceGuard } from '../workspace-guard.js';

/* ──────────────────────── ANSI Colors ──────────────────────── */

const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

/* ──────────────────────── GitManager ──────────────────────── */

export class GitManager {
  private cwd: string;
  private guard: WorkspaceGuard;

  constructor(cwd: string) {
    this.cwd = cwd;
    this.guard = new WorkspaceGuard(cwd);
  }

  /** Check if the current directory is inside a git repository. */
  isGitRepo(): boolean {
    try {
      const result = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: this.cwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return result.trim() === 'true';
    } catch {
      return false;
    }
  }

  /** Get the current branch name. */
  getCurrentBranch(): string {
    try {
      return execFileSync('git', ['branch', '--show-current'], {
        cwd: this.cwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim() || 'HEAD';
    } catch {
      return 'unknown';
    }
  }

  /** Check if there are uncommitted changes. */
  hasChanges(): boolean {
    try {
      const result = execFileSync('git', ['status', '--porcelain'], {
        cwd: this.cwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return result.trim().length > 0;
    } catch {
      return false;
    }
  }

  /** Get a list of files with uncommitted changes (staged, unstaged, or untracked). */
  getDirtyFiles(): string[] {
    if (!this.isGitRepo()) return [];
    try {
      const output = execFileSync('git', ['status', '--porcelain'], {
        cwd: this.cwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return output.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .map(line => {
          let p = line.slice(2).trim();
          if (p.startsWith('"') && p.endsWith('"')) {
            p = p.slice(1, -1).replace(/\\"/g, '"');
          }
          return p;
        });
    } catch {
      return [];
    }
  }

  /** Get a colored diff summary for display. */
  getDiff(): string {
    if (!this.isGitRepo()) return '(not a git repository)';
    if (!this.hasChanges()) return '(no changes)';

    try {
      const stat = execFileSync('git', ['diff', '--stat'], {
        cwd: this.cwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      const stagedStat = execFileSync('git', ['diff', '--cached', '--stat'], {
        cwd: this.cwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      const untrackedFiles = execFileSync(
        'git',
        ['ls-files', '--others', '--exclude-standard'],
        { cwd: this.cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      ).trim();

      const parts: string[] = [];

      if (stagedStat) {
        parts.push(`${colors.green}Staged:${colors.reset}`);
        parts.push(stagedStat);
      }
      if (stat) {
        parts.push(`${colors.yellow}Unstaged:${colors.reset}`);
        parts.push(stat);
      }
      if (untrackedFiles) {
        const files = untrackedFiles.split('\n').slice(0, 10);
        parts.push(`${colors.cyan}Untracked (${files.length}):${colors.reset}`);
        for (const f of files) parts.push(`  + ${f}`);
        if (untrackedFiles.split('\n').length > 10) parts.push(`  ... and more`);
      }

      return parts.join('\n') || '(no changes)';
    } catch {
      return '(could not generate diff)';
    }
  }

  /**
   * Auto-commit all changes with a generated commit message.
   * Returns the short commit hash, or null if nothing to commit.
   */
  autoCommit(task: string, modifiedFiles: string[]): string | null {
    if (modifiedFiles.length === 0) return null;
    if (!this.isGitRepo()) return null;

    try {
      const status = execFileSync('git', ['status', '--porcelain'], {
        cwd: this.cwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      
      if (!status) {
        console.log('  ℹ No local filesystem variations detected. Skipping git commit.');
        return null;
      }
      const lowerTask = task.toLowerCase();
      let prefix = 'feat';
      if (/\bfix(es|ed|ing)?\b/.test(lowerTask)) prefix = 'fix';
      else if (/\brefactor/.test(lowerTask)) prefix = 'refactor';
      else if (/\btest/.test(lowerTask)) prefix = 'test';
      else if (/\bdoc(s|umentation)?/.test(lowerTask)) prefix = 'docs';
      else if (/\bstyle|format/.test(lowerTask)) prefix = 'style';

      const taskSummary = task.length > 68 ? task.slice(0, 65) + '...' : task;
      const message = `${prefix}: ${taskSummary}`;

      for (const file of modifiedFiles) {
        const relativePath = this.guard.relative(this.guard.resolve(file, 'commit file'));
        execFileSync('git', ['add', '--', relativePath], {
          cwd: this.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      }

      const fileListForGit = modifiedFiles
        .map((f) => this.guard.relative(this.guard.resolve(f, 'commit file')));

      execFileSync('git', ['commit', '-m', `${message} [fixo-run:auto]`, '--', ...fileListForGit], {
        cwd: this.cwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const hash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: this.cwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      const fileList = modifiedFiles
        .map((f) => this.guard.relative(f))
        .slice(0, 5)
        .join(', ');

      console.log(
        `${colors.green}  ✓ Committed ${colors.bold}${hash}${colors.reset}${colors.green}: ${message}${colors.reset}`,
      );
      if (fileList) console.log(`${colors.dim}    Files: ${fileList}${colors.reset}`);
      return hash;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(`${colors.yellow}  ⚠ Auto-commit failed: ${msg.slice(0, 80)}${colors.reset}`);
      return null;
    }
  }

  /** Undo the last commit, performing a hard reset of the working tree. */
  undoLastCommit(): boolean {
    if (!this.isGitRepo()) {
      console.log(`${colors.red}  ✗ Not a git repository${colors.reset}`);
      return false;
    }

    if (this.hasChanges()) {
      console.log(
        `${colors.red}  ✗ Undo refused: You have uncommitted changes in your workspace. Please stash or commit them first to prevent data loss.${colors.reset}`,
      );
      return false;
    }

    try {
      const currentHash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: this.cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      const commitMsg = execFileSync('git', ['log', '-1', '--format=%s'], {
        cwd: this.cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      if (!commitMsg.includes('[fixo-run:')) {
        console.log(`${colors.red}  ✗ Undo refused: last commit is not marked as FixO-owned${colors.reset}`);
        return false;
      }

      execFileSync('git', ['reset', '--hard', 'HEAD~1'], { cwd: this.cwd, stdio: 'ignore' });

      console.log(`${colors.green}  ⏪ Hard-reset commit ${colors.bold}${currentHash}${colors.reset}${colors.green}: ${commitMsg}${colors.reset}`);
      console.log(`${colors.dim}    All files have been restored to the previous clean commit state.${colors.reset}`);
      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(`${colors.red}  ✗ Undo failed: ${msg.slice(0, 80)}${colors.reset}`);
      return false;
    }
  }

  /** Get last N commit messages for display. */
  getRecentCommits(count = 5): string {
    if (!this.isGitRepo()) return '(not a git repository)';
    try {
      return execFileSync('git', ['log', '--oneline', '-n', String(count)], {
        cwd: this.cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      }).trim() || '(no commits)';
    } catch {
      return '(no commits)';
    }
  }

  /** Discard all uncommitted modifications and untracked files in the workspace. */
  discardUncommittedChanges(): void {
    if (!this.isGitRepo()) return;
    try {
      execFileSync('git', ['checkout', '--', '.'], { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      execFileSync('git', ['clean', '-fd'], { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      console.log(`${colors.green}  ⏪ Discarded all uncommitted workspace changes due to execution failure.${colors.reset}`);
    } catch (error: any) {
      console.log(`${colors.yellow}  ⚠ Failed to discard uncommitted changes: ${error.message || error}${colors.reset}`);
    }
  }

  /**
   * Create a named workspace snapshot commit (works in non-auto-commit mode).
   * Stages all changes and commits with "fixo-snapshot: <label>" message.
   * Returns the short hash, or null if nothing to commit / not a git repo.
   */
  createSnapshot(label: string): string | null {
    if (!this.isGitRepo()) {
      console.log(`${colors.red}  ✗ Not a git repository — cannot create snapshot.${colors.reset}`);
      return null;
    }
    try {
      const status = execFileSync('git', ['status', '--porcelain'], {
        cwd: this.cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      if (!status) {
        console.log(`${colors.yellow}  ℹ No changes to snapshot.${colors.reset}`);
        return null;
      }

      execFileSync('git', ['add', '-A'], { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      const safeLabel = label.slice(0, 60).replace(/[^\w\s\-]/g, '').trim() || 'manual';
      execFileSync('git', ['commit', '-m', `fixo-snapshot: ${safeLabel} [fixo-run:snapshot]`], {
        cwd: this.cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      });

      const hash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: this.cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      console.log(`${colors.green}  📸 Snapshot committed ${colors.bold}${hash}${colors.reset}${colors.green}: fixo-snapshot: ${safeLabel}${colors.reset}`);
      return hash;
    } catch (error: any) {
      console.log(`${colors.yellow}  ⚠ Snapshot failed: ${(error.message || String(error)).slice(0, 80)}${colors.reset}`);
      return null;
    }
  }
}
