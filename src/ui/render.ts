import fs from "fs";
import path from "path";
import { colors, renderStatusLabel, themeMode } from "./colors.js";

const c = { ...colors, renderStatusLabel };

export const COMMANDS_WITH_DESC = [
  // Core
  { cmd: '/help', desc: 'Show all commands and usage' },
  { cmd: '/exit', desc: 'Exit FixO CLI' },
  { cmd: '/quit', desc: 'Exit FixO CLI' },
  // Model & Providers
  { cmd: '/model', desc: 'Interactive model picker or set model' },
  { cmd: '/providers', desc: 'Manage AI provider API keys (add/list/remove/test)' },
  // Files & Context
  { cmd: '/select', desc: 'Pin a file for agent context' },
  { cmd: '/unselect', desc: 'Clear all pinned files' },
  { cmd: '/index', desc: 'Build the local repo index' },
  { cmd: '/find', desc: 'Search the repo index' },
  { cmd: '/explain', desc: 'Explain a file or symbol from index' },
  // Conversation
  { cmd: '/clear', desc: 'Clear conversation history' },
  { cmd: '/compact', desc: 'Summarise & compress conversation (frees context tokens)' },
  { cmd: '/stats', desc: 'Show session token usage statistics' },
  { cmd: '/session', desc: 'Manage sessions: list | load <uuid> | new' },
  // Agent modes & plans
  { cmd: '/mode', desc: 'Toggle or set PLAN / BUILD execution mode' },
  { cmd: '/plan', desc: 'Generate a task execution plan' },
  { cmd: '/run-plan', desc: 'Execute the last generated plan' },
  // Git
  { cmd: '/diff', desc: 'Show git diff of workspace' },
  { cmd: '/undo', desc: 'Undo last auto-committed change' },
  { cmd: '/log', desc: 'Show recent git commits' },
  { cmd: '/snapshot', desc: 'Create a named git snapshot commit' },
  // Quality & review
  { cmd: '/review', desc: 'Review the current workspace diff' },
  { cmd: '/test', desc: 'Run detected project tests' },
  { cmd: '/fix-tests', desc: 'Run tests and auto-fix failures' },
  { cmd: '/fix-ci', desc: 'Fix CI failures (paste logs)' },
  // Runs & memory
  { cmd: '/runs', desc: 'List task run ledgers' },
  { cmd: '/show-run', desc: 'Show details of a specific run' },
  { cmd: '/memory', desc: 'Show project memory facts' },
  { cmd: '/remember', desc: 'Add a project fact to memory' },
  { cmd: '/forget', desc: 'Clear all project memory' },
  // Tools & skills
  { cmd: '/skills', desc: 'List all registered skill profiles' },
  { cmd: '/doctor', desc: 'Run FixO diagnostics / doctor checks' },
  // Privacy
  { cmd: '/telemetry', desc: 'Toggle telemetry on/off or view status' },
  // Theme
  { cmd: '/theme', desc: 'Toggle Dark Void / Inverted theme' },
  { cmd: '/variant', desc: 'Toggle theme color variant' },
];

export function getLogoString(pad = ''): string {
  const glyphs = {
    left: [
      "                  ",
      "█▀▀▀ ██  █  █ █▀▀█",
      "█__  ██   ▀▀  █__█",
      "▀    ▀▀  ▀  ▀ ▀~~▀"
    ],
    right: [
      "            ▄",
      "█▀▀▀ █    ██",
      "█___ █    ██",
      "▀▀▀▀ ▀▀▀▀ ▀▀"
    ]
  };

  const reset = "\x1b[0m";
  const isDark = themeMode === 'dark';
  const leftColors = {
    fg: "\x1b[38;2;56;189;248m", // Cyan / OpenCode left brand color
    shadow: isDark ? "\x1b[38;2;51;65;85m" : "\x1b[38;2;148;163;184m", // Slate shadow
    bg: isDark ? "\x1b[48;2;30;41;59m" : "\x1b[48;2;226;232;240m", // Slate bg
  };
  const rightColors = {
    fg: isDark ? "\x1b[38;2;251;251;251m" : "\x1b[38;2;21;20;25m", // Snow / OpenCode right brand color
    shadow: isDark ? "\x1b[38;2;71;85;105m" : "\x1b[38;2;100;116;139m", // Slate shadow light
    bg: isDark ? "\x1b[48;2;51;65;85m" : "\x1b[48;2;203;213;225m", // Slate bg light
  };

  const draw = (line: string, fg: string, shadow: string, bg: string) => {
    const parts: string[] = [];
    for (const char of line) {
      if (char === "_") {
        parts.push(bg, " ", reset);
        continue;
      }
      if (char === "^") {
        parts.push(fg, bg, "▀", reset);
        continue;
      }
      if (char === "~") {
        parts.push(shadow, "▀", reset);
        continue;
      }
      if (char === " ") {
        parts.push(" ");
        continue;
      }
      parts.push(fg, char, reset);
    }
    return parts.join("");
  };

  const result: string[] = [];
  const gap = " ";
  glyphs.left.forEach((row, index) => {
    if (pad) result.push(pad);
    result.push(draw(row, leftColors.fg, leftColors.shadow, leftColors.bg));
    result.push(gap);
    const other = glyphs.right[index] ?? "";
    result.push(draw(other, rightColors.fg, rightColors.shadow, rightColors.bg));
    result.push("\n");
  });

  return result.join("").trimEnd();
}

export function printWelcome(): void {
  console.log('');
  console.log(getLogoString('  '));
  console.log('');
  console.log(`  \x1b[38;2;56;189;248m──────────────────────────────────────────────────\x1b[0m`);
  console.log('');

  const terminalWidth = process.stdout.columns || 94;
  
  let numCols = 3;
  let colWidth = 29;
  let width = 94;

  if (terminalWidth < 68) {
    numCols = 1;
    width = 34;
  } else if (terminalWidth < 96) {
    numCols = 2;
    width = 64;
  }

  const borderTop = '┌' + '─'.repeat(width) + '┐';
  const borderBottom = '└' + '─'.repeat(width) + '┘';

  interface ColItem { cmd: string; desc: string; }

  const flatCommands: ColItem[] = [
    { cmd: '/help',      desc: 'Show all commands' },
    { cmd: '/providers', desc: 'Manage API keys'   },
    { cmd: '/model',     desc: 'Pick model'        },
    { cmd: '/mode',      desc: 'PLAN/BUILD toggle' },
    { cmd: '/plan',      desc: 'Create plan'       },
    { cmd: '/run-plan',  desc: 'Execute plan'      },
    { cmd: '/compact',   desc: 'Compress context'  },
    { cmd: '/session',   desc: 'Sessions'          },
    { cmd: '/skills',    desc: 'List skills'       },
    { cmd: '/exit',      desc: 'Exit FixO CLI'     },
    { cmd: '/select',   desc: 'Pin file'           },
    { cmd: '/unselect', desc: 'Clear pinned'       },
    { cmd: '/index',    desc: 'Build index'        },
    { cmd: '/find',     desc: 'Search index'       },
    { cmd: '/explain',  desc: 'Explain target'     },
    { cmd: '/review',   desc: 'Review diff'        },
    { cmd: '/test',     desc: 'Run tests'          },
    { cmd: '/fix-ci',   desc: 'Fix CI failures'    },
    { cmd: '/doctor',   desc: 'Doctor checks'      },
    { cmd: '/diff',     desc: 'Git diff'           },
    { cmd: '/log',      desc: 'Git log'            },
    { cmd: '/undo',     desc: 'Undo last commit'   },
    { cmd: '/snapshot', desc: 'Git snapshot'       },
    { cmd: '/memory',   desc: 'Show memory'        },
    { cmd: '/remember', desc: 'Add memory fact'    },
    { cmd: '/forget',   desc: 'Clear memory'       },
    { cmd: '/runs',     desc: 'List runs'          },
    { cmd: '/telemetry',desc: 'Toggle telemetry'   },
    { cmd: '/theme',    desc: 'Toggle theme'       },
  ];

  // Distribute flatCommands into columns
  const numRows = Math.ceil(flatCommands.length / numCols);
  const cols: ColItem[][] = Array.from({ length: numCols }, () => []);
  for (let i = 0; i < flatCommands.length; i++) {
    const colIdx = Math.floor(i / numRows);
    cols[colIdx].push(flatCommands[i]);
  }

  console.log(`${c.cyan}${borderTop}${c.reset}`);
  
  // Header line padding calculation
  const headerVisibleLength = 50; 
  const headerPadding = Math.max(0, width - headerVisibleLength);
  console.log(`${c.cyan}│${c.reset}  ${c.bold}Quick Command Reference${c.reset}  ${c.dim}(type /help for full docs)${c.reset}${' '.repeat(headerPadding)}${c.cyan}│${c.reset}`);
  console.log(`${c.cyan}├${'─'.repeat(width)}┤${c.reset}`);

  for (let r = 0; r < numRows; r++) {
    let rowText = '  ';
    for (let cIdx = 0; cIdx < numCols; cIdx++) {
      const item = cols[cIdx][r];
      if (item && item.cmd) {
        rowText += `${c.cyan}${item.cmd.padEnd(11)}${c.reset}${item.desc.padEnd(18)}`;
      } else {
        rowText += ' '.repeat(colWidth);
      }
    }
    const rowVisibleLength = 2 + numCols * colWidth;
    const rowPadding = Math.max(0, width - rowVisibleLength);
    console.log(`${c.cyan}│${c.reset}${rowText}${' '.repeat(rowPadding)}${c.cyan}│${c.reset}`);
  }

  console.log(`${c.cyan}│${c.reset}${' '.repeat(width)}${c.cyan}│${c.reset}`);
  
  // Footer text length: 91
  const footerVisibleLength = 91;
  const footerPadding = Math.max(0, width - footerVisibleLength);
  console.log(`${c.cyan}│${c.reset}  ${c.dim}Type @ to autocomplete files/agents · Type / to autocomplete commands · TAB to toggle mode${c.reset}${' '.repeat(footerPadding)}${c.cyan}│${c.reset}`);
  console.log(`${c.cyan}${borderBottom}${c.reset}`);
  console.log('');
}

export function printHelp(): void {
  const w = 72;
  const line = (cmd: string, args: string, desc: string) => {
    const left = `  ${c.cyan}${cmd}${c.reset} ${c.dim}${args}${c.reset}`;
    const stripped = `  ${cmd} ${args}`;
    const pad = Math.max(1, 32 - stripped.length);
    console.log(`${left}${' '.repeat(pad)}${desc}`);
  };

  console.log('');
  console.log(`${c.bold}${c.cyan}FixO CLI — All Commands${c.reset}`);
  console.log(`${c.dim}${'─'.repeat(w)}${c.reset}`);

  console.log(`\n${c.snow}${c.bold}🤖 Model & Providers${c.reset}`);
  line('/model',     '[name|list]',   'Interactive model picker, or set model by name');
  line('/providers', '<sub-command>', 'Manage provider API keys: list | add <name> | remove <name> | test <name>');

  console.log(`\n${c.snow}${c.bold}📂 Files & Context${c.reset}`);
  line('/select',    '[file]',        'Pin a file for focused agent context');
  line('/unselect',  '',              'Clear all pinned files');
  line('/index',     '',              'Build / refresh the local repo index');
  line('/find',      '<query>',       'Search the repo index for symbols or files');
  line('/explain',   '<target>',      'Explain a file, symbol, or function from the index');

  console.log(`\n${c.snow}${c.bold}💬 Conversation${c.reset}`);
  line('/clear',     '',              'Clear conversation history');
  line('/compact',   '',              'Summarise & compress conversation (frees context tokens)');
  line('/stats',     '',              'Show session token usage and cost savings');
  line('/session',   '<sub-command>', 'Manage sessions: list | load <uuid> | new');

  console.log(`\n${c.snow}${c.bold}⚙️  Agent Modes & Plans${c.reset}`);
  line('/mode',      '[PLAN|BUILD]',  'Toggle or set execution mode (PLAN = read-only, BUILD = write)');
  line('/plan',      '<task>',        'Generate a structured multi-phase execution plan');
  line('/run-plan',  '',              'Execute the last saved plan via the Agent Pool');

  console.log(`\n${c.snow}${c.bold}🌳 Git Operations${c.reset}`);
  line('/diff',      '',              'Show git diff of the workspace');
  line('/undo',      '',              'Undo the last FixO auto-committed change');
  line('/log',       '',              'Show recent git commits');
  line('/snapshot',  '[label]',       'Create a named git snapshot commit of current workspace');

  console.log(`\n${c.snow}${c.bold}🔍 Quality & Review${c.reset}`);
  line('/review',    '',              'Review the current diff for issues');
  line('/test',      '',              'Run detected project tests');
  line('/fix-tests', '',              'Run tests and automatically fix failures');
  line('/fix-ci',    '',              'Fix CI failures (paste CI logs into the task)');

  console.log(`\n${c.snow}${c.bold}📋 Runs & Memory${c.reset}`);
  line('/runs',      '',              'List all recorded task run ledgers');
  line('/show-run',  '<id>',          'Show details of a specific run');
  line('/memory',    '',              'Show all project memory facts');
  line('/remember',  '<fact>',        'Add a project fact to persistent memory');
  line('/forget',    '',              'Clear all project memory');

  console.log(`\n${c.snow}${c.bold}🛠  Tools & Skills${c.reset}`);
  line('/skills',    '',              'List all registered and auto-detected skill profiles');
  line('/doctor',    '',              'Run FixO diagnostics and troubleshooting checks');

  console.log(`\n${c.snow}${c.bold}🔒 Privacy${c.reset}`);
  line('/telemetry', '<on|off>',      'View or toggle telemetry collection');

  console.log(`\n${c.snow}${c.bold}🎨 Theme${c.reset}`);
  line('/theme',     '',              'Toggle Dark Void Minimalist / High-Contrast Inverted theme');
  line('/variant',   '',              'Toggle theme color variant');

  console.log(`\n${c.snow}${c.bold}🚪 Exit${c.reset}`);
  line('/exit',      '',              'Exit FixO CLI cleanly');
  line('/quit',      '',              'Alias for /exit');

  console.log(`\n${c.dim}${'─'.repeat(w)}${c.reset}`);
  console.log(`${c.dim}  Shell commands   prefix with !  e.g. !npm test, !ls -la${c.reset}`);
  console.log(`${c.dim}  Autocomplete     type / for commands, @ for files & agents${c.reset}`);
  console.log(`${c.dim}  Mode toggle      press [TAB] on an empty line to switch PLAN ↔ BUILD${c.reset}`);
  console.log('');
}

export function buildPromptString(cwd: string, model: string, branch: string): string {
  const dirName = path.basename(cwd);
  const dirLabel = c.renderStatusLabel(`📂 ${dirName}`);
  const branchLabel = branch ? ` ${c.renderStatusLabel(`🌳 ${branch}`)}` : '';
  const modelLabel = ` ${c.renderStatusLabel(`🤖 ${model}`)}`;
  return `\n${dirLabel}${branchLabel}${modelLabel}\n${c.cyan}❯${c.reset} `;
}

export function formatInputPaths(input: string, cwd: string): string {
  const commands = COMMANDS_WITH_DESC.map((item) => item.cmd);

  // Replace absolute/relative paths with just the filename highlighted
  return input.replace(/(?:\/[\w.-]+)+/g, (match) => {
    if (match.startsWith('/')) {
      const commandName = match.split(/\s+/)[0];
      if (commands.includes(commandName) || commandName.length <= 4) {
        return match;
      }
    }
    const resolved = path.isAbsolute(match) ? match : path.resolve(cwd, match);
    if (fs.existsSync(resolved)) {
      const basename = path.basename(match);
      return `${c.cyan}${c.bold}${basename}${c.reset}`;
    }
    return match;
  });
}
