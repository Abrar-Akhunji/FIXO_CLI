import type { ChatToolDefinition } from '../shared/types.js';

export const TOOL_DEFINITIONS: ChatToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read the full text contents of a file at the given path. Use this to understand existing code before making changes. Returns the file contents as a string. Files larger than the large-file gate (15 KiB / 350 lines by default) will return a [Context-Budget Guard] synthetic directive telling you to call extract_symbols or extract_imports first.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'The file path to read, relative to the workspace root or absolute.',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'extract_symbols',
      description:
        'Extract symbol declarations (classes, functions, interfaces, types, consts) from a file. Output is capped at 100 entries. Cheaper than read_file for large files because it skips the body content.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'The file path to inspect, relative to the workspace root or absolute.',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'extract_imports',
      description:
        'Extract import statements from a file. Output is capped at 100 entries. Cheaper than read_file for large files because it skips the body content.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'The file path to inspect, relative to the workspace root or absolute.',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'apply_patch',
      description: 'Apply a unified diff patch to files in the workspace. Prefer this over write_file for editing existing files, and NEVER substitute it with `sed -i`, `patch < file`, or `python3 -c` — shell file-writing is sandbox-blocked.',
      parameters: {
        type: 'object',
        properties: {
          patch: { type: 'string', description: 'Unified diff patch text.' },
        },
        required: ['patch'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'replace_range',
      description: 'Replace inclusive 1-based line range in a file. Requires reading the file first.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          startLine: { type: 'string' },
          endLine: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'startLine', 'endLine', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'insert_after',
      description: 'Insert content after the first exact anchor match in a file. Requires reading the file first.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          anchor: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'anchor', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'rename_file',
      description: 'Rename or move a workspace file.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
        },
        required: ['from', 'to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Write a complete file to disk. Use ONLY for new files or full rewrites where the prior content is irrelevant. Never use `run_command` with `cat > file`, heredocs, `tee`, `sed -i`, or `python3 -c`/`node -e` to write files — those are sandbox-blocked. For ANY change to an existing file you MUST use `str_replace` (single hunk) or `apply_patch` (multi-region). Rewriting an existing file with write_file when str_replace would do wastes tokens, defeats LSP granularity, and risks clobbering concurrent edits. Creates parent directories if missing.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'The file path to write, relative to the workspace root or absolute.',
          },
          content: {
            type: 'string',
            description: 'The full file content to write.',
          },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Execute a shell command and return its stdout and stderr output. Use this to run tests, build projects, install dependencies, or verify changes. Commands run in the workspace directory. DO NOT use this tool to write or edit files — shell-based file writing is sandbox-blocked, including: `>` / `>>` redirects, `cat > file <<EOF` heredocs, `tee`, `sed -i`, `mv`/`cp` into source paths, and interpreter payloads like `python3 -c "open(...,\'w\')"`, `node -e "fs.writeFileSync(...)"`. Attempts to write files this way will be rejected with a security error. For file writes use `write_file` (new files / full rewrites), `str_replace` (single-region edit), or `apply_patch` (multi-region diff) — they all go through the same atomic staging + LSP pre-save pipeline.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command to execute.',
          },
          cwd: {
            type: 'string',
            description:
              'Working directory for the command (optional, defaults to workspace root).',
          },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command_async',
      description:
        'Spawn a long-running command in the background and return immediately with a jobId. Use poll_command_status to retrieve output and kill_command to terminate. Output streams cap at 64 KiB each; the larger totalByte counters survive the cap. Rejected in PLAN mode. Workspace-escape and sensitive-file commands are blocked at spawn time by the same command-parser used by run_command.',
      parameters: {
        type: 'object',
        properties: {
          cmd: { type: 'string', description: 'The binary to spawn.' },
          args: {
            type: 'array',
            items: { type: 'string' },
            description: 'Argument vector.',
          },
          cwd: {
            type: 'string',
            description: 'Working directory (defaults to workspace root).',
          },
        },
        required: ['cmd'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'poll_command_status',
      description:
        'Read a snapshot of a background job. The snapshot includes status, exitCode, startedAt/exitedAt, and the (capped) stdout and stderr streams. tailLines truncates each stream to its last N lines; sinceBytes returns only the bytes after the given offset on stdout/stderr (delta fields).',
      parameters: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: 'The jobId returned by run_command_async.' },
          tailLines: { type: 'integer', description: 'Truncate each stream to last N lines.' },
          sinceBytes: { type: 'integer', description: 'Return only bytes after this offset.' },
        },
        required: ['jobId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'kill_command',
      description: 'Send SIGTERM to a background job. No-op if the job has already exited.',
      parameters: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: 'The jobId to terminate.' },
        },
        required: ['jobId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_code',
      description:
        'Search for a text or regex pattern in workspace files. Returns matching lines with file paths and line numbers. Use this to find where functions, classes, or variables are defined or used.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search pattern (plain text or regex).',
          },
          path: {
            type: 'string',
            description:
              'Directory or file to search in (optional, defaults to workspace root).',
          },
          file_pattern: {
            type: 'string',
            description:
              'Glob pattern to filter files, e.g., "*.ts" or "*.py" (optional).',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description:
        'List files and directories at the given path. Returns names, types (file/dir), and sizes.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'The directory path to list (optional, defaults to workspace root).',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file at the given path from the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The file path to delete, relative to the workspace root or absolute.',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_branch',
      description: 'Create and checkout a new Git branch.',
      parameters: {
        type: 'object',
        properties: {
          branchName: { type: 'string', description: 'The name of the branch to create.' },
        },
        required: ['branchName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'commit_changes',
      description: 'Stage all current changes and commit them.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'The commit message.' },
        },
        required: ['message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'push_branch',
      description: 'Push the current active branch to origin or custom remote.',
      parameters: {
        type: 'object',
        properties: {
          remote: { type: 'string', description: 'The remote repository name (default: origin).' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_pull_request',
      description: 'Create a pull request on GitHub for the current branch.',
      parameters: {
        type: 'object',
        properties: {
          baseBranch: { type: 'string', description: 'The base branch to merge into (default: main).' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lsp_goto_definition',
      description: 'Find definition coordinates for a symbol at a given 0-indexed line and character position using LSP.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path containing the symbol.' },
          line: { type: 'integer', description: '0-indexed line number.' },
          character: { type: 'integer', description: '0-indexed character offset.' },
        },
        required: ['path', 'line', 'character'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lsp_find_references',
      description: 'Find all reference locations for a symbol at a given 0-indexed line and character position using LSP.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path containing the symbol.' },
          line: { type: 'integer', description: '0-indexed line number.' },
          character: { type: 'integer', description: '0-indexed character offset.' },
        },
        required: ['path', 'line', 'character'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lsp_hover',
      description: 'Retrieve type information and documentation for a symbol at a given 0-indexed line and character position using LSP.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path containing the symbol.' },
          line: { type: 'integer', description: '0-indexed line number.' },
          character: { type: 'integer', description: '0-indexed character offset.' },
        },
        required: ['path', 'line', 'character'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch a webpage using an HTTP GET request and return its content converted to Markdown. Use this to read documentation or external references.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The absolute URL to fetch.' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Perform a web search for a given query and return a list of search results as Markdown snippets. Use this to find information on the web.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'str_replace',
      description:
        'Use this tool by default for any in-place edit to an existing file. Performs a surgical, atomic replacement of oldString with newString. By default, oldString must be unique within the file (expectUnique=true) — non-unique matches are rejected with a clear error so the caller can narrow the snippet. Pass replaceAll=true to substitute every occurrence. Rejected in PLAN mode. Refused for platform-locked paths. Goes through the same atomic staging pipeline as write_file and the LSP pre-save gate before any disk mutation. NEVER substitute this with shell commands like `sed -i`, `python3 -c`, or `cat > file` — those are sandbox-blocked.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The file path to edit, relative to the workspace root or absolute.',
          },
          oldString: {
            type: 'string',
            description: 'The exact substring to replace. Must appear in the file.',
          },
          newString: {
            type: 'string',
            description: 'The replacement content.',
          },
          replaceAll: {
            type: 'boolean',
            description: 'If true, replace every occurrence. Default false.',
          },
          expectUnique: {
            type: 'boolean',
            description:
              'If true (default), the operation aborts when oldString is not unique. Set to false to allow non-unique matches with the first occurrence replaced.',
          },
        },
        required: ['path', 'oldString', 'newString'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'todo_read',
      description:
        'Read the current project todo list from <cwd>/.fixo/todo_list.json. Returns a human-readable rendering of all items grouped into Open and Completed. A missing or unreadable file yields an empty list — by design.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'todo_write',
      description:
        'Mutate the project todo list. Operations: add (content+blockedBy optional), set_status (id+status), remove (id), clear_done. Persisted atomically to <cwd>/.fixo/todo_list.json. Rejected in PLAN mode. IMPORTANT: Do NOT provide an `id` when using `op: "add"`, the system generates it. Only use `id` for `set_status` or `remove` using IDs from `todo_read`.',
      parameters: {
        type: 'object',
        properties: {
          op: {
            type: 'string',
            enum: ['add', 'set_status', 'remove', 'clear_done'],
            description: 'The mutation to apply.',
          },
          content: {
            type: 'string',
            description: 'Item content (op=add only).',
          },
          id: {
            type: 'string',
            description: 'Item id (op=set_status, op=remove). OMIT FOR op=add.',
          },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'done', 'cancelled'],
            description: 'New status (op=set_status only).',
          },
          blockedBy: {
            type: 'string',
            description: 'Optional blocker description (op=add only).',
          },
        },
        required: ['op'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob_files',
      description:
        'High-performance filesystem pattern matcher. Returns paths matching the given glob pattern, relative to the workspace root. Built on Node 22+ native fs.promises.glob. By default, common build/VCS directories (node_modules, .git, dist, .fixo, .fixocli) are excluded. Symlinks are not followed and hidden files are excluded unless explicitly enabled. Capped at maxResults (default 1000, hard cap 5000).',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Glob pattern, e.g. "src/**/*.ts" or "**/package.json".',
          },
          cwd: {
            type: 'string',
            description:
              'Optional directory to scope the glob. Must resolve inside the workspace. Defaults to the workspace root.',
          },
          ignore: {
            type: 'string',
            description:
              'Optional extra glob pattern (or comma-separated patterns) to add to the default skip set.',
          },
          maxResults: {
            type: 'integer',
            description: 'Maximum number of results to return. Default 1000, hard cap 5000.',
          },
          includeHidden: {
            type: 'boolean',
            description: 'If true, do not exclude dotfile entries from the match. Default false.',
          },
          followSymlinks: {
            type: 'boolean',
            description:
              'If true, follow symbolic links during traversal. Default false (safer).',
          },
        },
        required: ['pattern'],
      },
    },
  },
];
