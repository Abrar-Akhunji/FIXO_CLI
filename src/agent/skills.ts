import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { getConfigDir } from '../config.js';

export interface SkillInfo {
  name: string;
  description?: string;
  location: string;
  content: string;
}

export function parseSkillFile(filePath: string): SkillInfo | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const match = raw.match(/^---\r?\n([\s\S]+?)\r?\n---\r?\n([\s\S]*)$/);
    if (!match) {
      // No frontmatter, treat whole file as content, name is filename
      const name = path.basename(path.dirname(filePath));
      return {
        name,
        location: filePath,
        content: raw.trim(),
      };
    }
    const frontmatter = yaml.load(match[1]) as any;
    if (frontmatter && typeof frontmatter.name === 'string') {
      return {
        name: frontmatter.name,
        description: frontmatter.description,
        location: filePath,
        content: match[2].trim(),
      };
    }
  } catch (e) {
    console.warn(`[Skills] Failed to parse skill file ${filePath}:`, e);
  }
  return null;
}

export class SkillsManager {
  private skills = new Map<string, SkillInfo>();

  initialize(cwd: string): void {
    this.skills.clear();
    // 1. Load global skills from ~/.fixocli/skills/
    const globalSkillsDir = path.join(getConfigDir(), 'skills');
    this.scanDir(globalSkillsDir);

    // 2. Load local project skills from .fixocli/skills/
    const localSkillsDir = path.join(cwd, '.fixocli', 'skills');
    this.scanDir(localSkillsDir);
  }

  private scanDir(dir: string): void {
    if (!fs.existsSync(dir)) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillFile = path.join(dir, entry.name, 'SKILL.md');
          if (fs.existsSync(skillFile)) {
            const skill = parseSkillFile(skillFile);
            if (skill) {
              this.skills.set(skill.name, skill);
            }
          }
        }
      }
    } catch (e) {
      console.warn(`[Skills] Error scanning directory ${dir}:`, e);
    }
  }

  getSkills(): SkillInfo[] {
    return Array.from(this.skills.values());
  }

  getSkill(name: string): SkillInfo | undefined {
    return this.skills.get(name);
  }

  /**
   * Dynamically detect which skills are relevant to the workspace.
   * We check the languages/file extensions in cwd, or if the task references them.
   */
  getRelevantSkillsPrompt(cwd: string, task: string): string {
    const activeSkills: string[] = [];
    const lowerTask = task.toLowerCase();

    for (const skill of this.skills.values()) {
      let isRelevant = false;

      // If task mentions the skill name
      if (lowerTask.includes(skill.name.toLowerCase())) {
        isRelevant = true;
      }

      // Or if workspace has files related to the skill
      // e.g. react (tsx/jsx), go (go), rust (rs)
      if (!isRelevant) {
        if (skill.name === 'react' && this.hasExtension(cwd, ['.tsx', '.jsx'])) {
          isRelevant = true;
        } else if (skill.name === 'go' && this.hasExtension(cwd, ['.go'])) {
          isRelevant = true;
        } else if (skill.name === 'rust' && this.hasExtension(cwd, ['.rs'])) {
          isRelevant = true;
        } else if (skill.name === 'typescript' && this.hasExtension(cwd, ['.ts', '.tsx'])) {
          isRelevant = true;
        } else if (skill.name === 'python' && this.hasExtension(cwd, ['.py'])) {
          isRelevant = true;
        }
      }

      if (isRelevant) {
        activeSkills.push(`### Skill: ${skill.name}\n${skill.content}`);
      }
    }

    if (activeSkills.length === 0) return '';
    return `\n## Detected Workspace Skills & Framework Rules\n` + activeSkills.join('\n\n');
  }

  private hasExtension(dir: string, extensions: string[], maxDepth = 4, currentDepth = 0): boolean {
    if (currentDepth > maxDepth) return false;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') continue;
        if (entry.isDirectory()) {
          if (this.hasExtension(path.join(dir, entry.name), extensions, maxDepth, currentDepth + 1)) return true;
        } else {
          const ext = path.extname(entry.name).toLowerCase();
          if (extensions.includes(ext)) return true;
        }
      }
    } catch (error: unknown) {
      if (process.env.DEBUG || process.env.VERBOSE || process.argv.includes('--verbose')) {
        const msg = error instanceof Error ? error.message : String(error);
        console.warn(`[Debug Warning] Failed to read directory ${dir} during skill detection: ${msg}`);
      }
    }
    return false;
  }
}

export const skillsManager = new SkillsManager();
