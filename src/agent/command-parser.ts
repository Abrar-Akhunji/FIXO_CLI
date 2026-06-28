import path from "path";
import os from "os";
import { WorkspaceGuard, PlatformPathLockedError } from "../workspace-guard.js";
import { ParserFactory, type ParsedCommand } from "./parser-adapter.js";

export { ParserFactory };
export type { ParsedCommand } from "./parser-adapter.js";

/**
 * Where in a command a write target was discovered. Used so error
 * messages can explain *why* the path was flagged (e.g. "redirect"
 * vs "sed -i" vs "python -c open(...,'w')").
 */
export type WriteTargetKind =
  "redirect" | "sed-in-place" | "tee" | "mv-cp-dest" | "interpreter-script";

export interface WriteTarget {
  /** Raw path string as it appeared in the command. */
  path: string;
  /** What surface revealed this as a write target. */
  kind: WriteTargetKind;
  /** Optional binary that owned the write (e.g. "python3", "sed"). */
  via?: string;
}

/**
 * Detects file paths that a shell command will write to, even when
 * the write happens via redirects, sed -i, tee, mv/cp, or interpreter
 * `-c`/`-e` payloads.
 *
 * This is the shell-side counterpart to the platform-path lock that
 * the surgical/write/edit tools already enforce. The point is to stop
 * an agent from doing
 *   `python3 -c "open('src/foo.ts','w').write(...)"`
 * to side-step `PlatformPathLockedError`.
 *
 * Implementation notes:
 *   - Operates on the raw command string (regex), not the parsed AST,
 *     because tree-sitter strips redirects from the per-command arg
 *     list. We deliberately accept some false positives here — the
 *     callsite turns them into a "needs human confirmation" prompt,
 *     never a silent allow.
 *   - For interpreter `-c`/`-e` payloads we extract quoted-string
 *     file targets via a conservative regex. Anything we cannot
 *     classify is reported as `interpreter-script` so the caller
 *     can decide whether to require confirmation.
 */
export function extractWriteTargets(raw: string): WriteTarget[] {
  const out: WriteTarget[] = [];
  const seen = new Set<string>();
  const push = (t: WriteTarget): void => {
    const key = `${t.kind}|${t.path}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };

  // 1. Redirects: `> file`, `>> file`, `1> file`, `&> file`.
  //    Skip `2>&1`, `>&2` etc. by requiring a path-like token after.
  const redirectRe = /(?:^|[\s;&|()])(?:&|\d)?>{1,2}\s*([^\s;&|()<>]+)/g;
  for (const m of raw.matchAll(redirectRe)) {
    const target = stripQuotes(m[1]);
    // `>&1`, `>&2` are fd duplications, not file paths.
    if (/^&\d+$/.test(target)) continue;
    if (target.startsWith("/dev/")) continue;
    push({ path: target, kind: "redirect" });
  }

  // 2. `tee [-a] file…` writes each non-flag arg.
  const teeRe = /(?:^|[\s;&|()])tee\b([^;&|()]*)/g;
  for (const m of raw.matchAll(teeRe)) {
    for (const arg of splitArgs(m[1])) {
      if (arg.startsWith("-")) continue;
      push({ path: stripQuotes(arg), kind: "tee", via: "tee" });
    }
  }

  // 3. `sed -i[''] … file…` and `perl -i … file…` (in-place edit).
  const inPlaceRe =
    /(?:^|[\s;&|()])(sed|perl|gawk|awk)\s+([^;&|()]*?-i\b[^;&|()]*)/g;
  for (const m of raw.matchAll(inPlaceRe)) {
    const bin = m[1];
    const args = splitArgs(m[2]);
    let sawScript = false;
    for (const arg of args) {
      if (arg.startsWith("-")) continue;
      // The first non-flag arg is the sed/perl script, not a file.
      // Subsequent non-flag args are file targets.
      if (!sawScript) {
        sawScript = true;
        continue;
      }
      push({ path: stripQuotes(arg), kind: "sed-in-place", via: bin });
    }
  }

  // 4. `mv SRC DEST` / `cp SRC DEST` — last positional is destination.
  const mvCpRe = /(?:^|[\s;&|()])(mv|cp)\b([^;&|()]*)/g;
  for (const m of raw.matchAll(mvCpRe)) {
    const args = splitArgs(m[2]).filter((a) => !a.startsWith("-"));
    if (args.length >= 2) {
      const dest = stripQuotes(args[args.length - 1]);
      push({ path: dest, kind: "mv-cp-dest", via: m[1] });
    }
  }

  // 5. Interpreter scripts: `python3 -c "..."`, `node -e "..."`, etc.
  //    We can't use the coarse segment splitter here because the
  //    script body often contains `(`, `)`, `|`, `&` etc. that the
  //    splitter would treat as command boundaries. Instead, find the
  //    interpreter+flag, then walk the string capturing the quoted
  //    payload that follows.
  const scriptHostRe =
    /(?:^|[\s;&|()`])(python3?|node|perl|ruby|bash|sh|zsh)\s+(?:[^\s;&|()`]*\s+)?(-[ce])\b\s*/g;
  for (const m of raw.matchAll(scriptHostRe)) {
    const bin = m[1];
    const payloadStart = m.index! + m[0].length;
    const payload = readQuotedPayloadAt(raw, payloadStart);
    if (!payload) continue;
    for (const p of extractScriptWriteTargets(payload)) {
      push({ path: p, kind: "interpreter-script", via: bin });
    }
  }

  // 6. Heredoc: `cat > file << EOF … EOF` already caught by #1, but
  //    `python3 << 'PYEOF' … PYEOF` smuggles writes inside the body.
  const heredocRe = /<<\s*['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\b/g;
  for (const m of raw.matchAll(heredocRe)) {
    for (const p of extractScriptWriteTargets(m[2])) {
      push({ path: p, kind: "interpreter-script", via: "heredoc" });
    }
  }

  return out;
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if (t.length < 2) return t;
  const f = t[0];
  const l = t[t.length - 1];
  if ((f === '"' || f === "'") && f === l) return t.slice(1, -1);
  return t;
}

function splitArgs(s: string): string[] {
  // Very small splitter: respects single/double quotes; we do not
  // try to be a full shell lexer — the regexes above already
  // sectioned the command on `;`, `&`, `|`, parens.
  const out: string[] = [];
  let buf = "";
  let q: '"' | "'" | null = null;
  for (const ch of s) {
    if (q) {
      buf += ch;
      if (ch === q) q = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
      buf += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (buf) {
        out.push(buf);
        buf = "";
      }
      continue;
    }
    buf += ch;
  }
  if (buf) out.push(buf);
  return out;
}

/**
 * Read a single-, double-, or backtick-quoted string starting at
 * `start` (or skip leading whitespace first). Backslash escapes
 * are honoured so that `\"` inside a `"…"` block doesn't terminate
 * the payload. Returns the inner contents on success, `null` if no
 * quoted payload was found.
 */
function readQuotedPayloadAt(raw: string, start: number): string | null {
  let i = start;
  while (i < raw.length && /\s/.test(raw[i])) i++;
  if (i >= raw.length) return null;
  const q = raw[i];
  if (q !== '"' && q !== "'" && q !== "`") return null;
  i++;
  let out = "";
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === "\\" && i + 1 < raw.length) {
      out += raw[i + 1];
      i += 2;
      continue;
    }
    if (ch === q) return out;
    out += ch;
    i++;
  }
  return out; // unterminated — be lenient
}

function extractScriptWriteTargets(script: string): string[] {
  const targets = new Set<string>();
  // Python: open('X','w'), open("X", "w"), Path('X').write_text(...)
  const pyOpen = /open\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"][wax][+bt]*['"]/g;
  for (const m of script.matchAll(pyOpen)) targets.add(m[1]);
  const pyPath =
    /Path\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\.\s*write_(text|bytes)\b/g;
  for (const m of script.matchAll(pyPath)) targets.add(m[1]);

  // Node: fs.writeFile(Sync), fs.appendFile(Sync), writeFile(Sync),
  // fs.createWriteStream, fs.promises.writeFile
  const nodeWrite =
    /(?:fs(?:\.promises)?\.)?(?:writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream)\s*\(\s*['"]([^'"]+)['"]/g;
  for (const m of script.matchAll(nodeWrite)) targets.add(m[1]);

  // Perl: open(FH, '>', 'X') or open(FH, '>X')
  const perl1 = /open\s*\(\s*\w+\s*,\s*['"]>\s*([^'"]+)['"]/g;
  for (const m of script.matchAll(perl1)) targets.add(m[1]);
  const perl2 = /open\s*\(\s*\w+\s*,\s*['"]>+['"]\s*,\s*['"]([^'"]+)['"]/g;
  for (const m of script.matchAll(perl2)) targets.add(m[1]);

  // Ruby: File.open('X','w'), File.write('X', ...)
  const ruby =
    /File\s*\.\s*(?:open\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"][wax][+bt]*['"]|write\s*\(\s*['"]([^'"]+)['"])/g;
  for (const m of script.matchAll(ruby)) targets.add(m[1] ?? m[2]);

  // Embedded shell redirects inside the script body.
  for (const m of script.matchAll(
    /(?:^|[\s;&|()])(?:&|\d)?>{1,2}\s*([^\s;&|()<>]+)/g,
  )) {
    const t = stripQuotes(m[1]);
    if (!/^&\d+$/.test(t) && !t.startsWith("/dev/")) targets.add(t);
  }

  return [...targets];
}

/**
 * Parses a shell command string into individual binary and arguments sets.
 *
 * Resolves the active parser via the `ParserFactory` singleton. When the
 * underlying tree-sitter engine is healthy, the AST is used for maximum
 * accuracy. When the WASM is unavailable (architecture mismatch, missing
 * vendor file, etc.) the factory falls back transparently to a pure-JS
 * regex tokenizer — the rest of the safety check pipeline keeps working
 * unchanged.
 */
export async function parseShellCommand(
  command: string,
): Promise<ParsedCommand[]> {
  const parser = await ParserFactory.getParser();
  return parser.parseShellCommand ? parser.parseShellCommand(command) : [];
}

export interface CommandSafetyResult {
  safe: boolean;
  reason?: string;
  affectedPath?: string;
}

const DANGEROUS_MODIFIERS = new Set([
  "rm",
  "mv",
  "cp",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "dd",
  "ln",
  "rmdir",
]);

const DANGEROUS_READERS = new Set([
  "cat",
  "less",
  "more",
  "grep",
  "head",
  "tail",
]);

interface ScaffolderDefinition {
  bin: string;
  isScaffolder: (args: string[]) => boolean;
  extractTargetPath: (args: string[]) => string | null;
}

const KNOWN_SCAFFOLDERS: ScaffolderDefinition[] = [
  {
    bin: "npx",
    isScaffolder: (args) => args.length > 0 && args[0].startsWith("create-"),
    extractTargetPath: (args) => {
      const posArgs = args.filter((a) => !a.startsWith("-"));
      return posArgs.length > 1 ? posArgs[1] : null;
    },
  },
  {
    bin: "npm",
    isScaffolder: (args) =>
      args.length > 0 && (args[0] === "create" || args[0] === "init"),
    extractTargetPath: (args) => {
      const posArgs = args.filter((a) => !a.startsWith("-"));
      return posArgs.length > 2 ? posArgs[2] : null;
    },
  },
  {
    bin: "yarn",
    isScaffolder: (args) => args.length > 0 && args[0] === "create",
    extractTargetPath: (args) => {
      const posArgs = args.filter((a) => !a.startsWith("-"));
      return posArgs.length > 2 ? posArgs[2] : null;
    },
  },
  {
    bin: "pnpm",
    isScaffolder: (args) => args.length > 0 && args[0] === "create",
    extractTargetPath: (args) => {
      const posArgs = args.filter((a) => !a.startsWith("-"));
      return posArgs.length > 2 ? posArgs[2] : null;
    },
  },
  {
    bin: "git",
    isScaffolder: (args) => args.length > 0 && args[0] === "clone",
    extractTargetPath: (args) => {
      const posArgs = args.filter((a) => !a.startsWith("-"));
      if (posArgs.length > 2) return posArgs[2];
      if (posArgs.length === 2) {
        const url = posArgs[1];
        let base = url.split("/").pop() || "";
        if (base.endsWith(".git")) base = base.slice(0, -4);
        return base || null;
      }
      return null;
    },
  },
  {
    bin: "degit",
    isScaffolder: () => true,
    extractTargetPath: (args) => {
      const posArgs = args.filter((a) => !a.startsWith("-"));
      if (posArgs.length > 1) return posArgs[1];
      if (posArgs.length === 1) {
        const repo = posArgs[0];
        const parts = repo.split("/");
        return parts.length > 0 ? parts[parts.length - 1] : null;
      }
      return null;
    },
  },
];

/**
 * System binaries that the agent is permitted to invoke even when
 * referenced via an absolute or workspace-relative path that resolves
 * outside the workspace root (e.g. `/usr/bin/git`, `/opt/homebrew/bin/node`).
 *
 * The per-argument safety checks below (workspace containment for
 * `DANGEROUS_MODIFIERS`, sensitive-file detection for reads and writes)
 * still apply — only the "binary lives outside the workspace" rejection
 * is bypassed. This unblocks the common case of the agent running its
 * own toolchain (git, node, npm, ...) without weakening the file
 * containment guarantees.
 */
const ALLOWED_GLOBAL_BINARIES = new Set([
  "git",
  "node",
  "npm",
  "npx",
  "bash",
  "sh",
  "cat",
  "grep",
  "mkdir",
  "rm",
]);

function unquote(str: string): string {
  if (str.length < 2) return str;
  const first = str[0];
  const last = str[str.length - 1];
  if ((first === '"' || first === "'") && first === last) {
    return str.slice(1, -1);
  }
  return str;
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/**
 * Phase 1a — value-arg-aware positional extraction.
 *
 * Given the raw arg list of a command, return the positional args
 * (i.e. NOT flags AND NOT the value of a known value-taking flag).
 *
 * Without this, `find . -type f` would expose `f` as a positional —
 * the directory-creation heuristic then mistakes it for a new
 * directory name. The list covers the value-taking flags of the
 * common POSIX inspection tools (`find`, `grep`, `awk`, etc.) that
 * are most often confused.
 */
const VALUE_TAKING_FLAGS: ReadonlySet<string> = new Set([
  // `find` predicates that consume the next arg
  "-type",
  "-name",
  "-iname",
  "-path",
  "-ipath",
  "-regex",
  "-iregex",
  "-perm",
  "-newer",
  "-mtime",
  "-atime",
  "-ctime",
  "-mmin",
  "-amin",
  "-cmin",
  "-size",
  "-user",
  "-group",
  "-uid",
  "-gid",
  "-maxdepth",
  "-mindepth",
  "-depth",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-printf",
  "-fprintf",
  "-fprint",
  // grep / ripgrep style
  "-e",
  "-f",
  "--include",
  "--exclude",
  "--include-dir",
  "--exclude-dir",
  "--max-count",
  "--max-depth",
  "--context",
  "--before-context",
  "--after-context",
  // common short flags that take a value
  "-A",
  "-B",
  "-C",
  "-o",
  "-n",
  // sed/awk
  "-F",
]);

function stripFlagValues(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("-")) {
      // If this is a known value-taking flag AND there's a next arg
      // that isn't itself a flag, skip the next arg too.
      if (
        VALUE_TAKING_FLAGS.has(a) &&
        i + 1 < args.length &&
        !args[i + 1].startsWith("-")
      ) {
        i++; // consume the value
      }
      continue;
    }
    out.push(a);
  }
  return out;
}

function describeKind(t: WriteTarget): string {
  switch (t.kind) {
    case "redirect":
      return "shell redirect (>, >>)";
    case "sed-in-place":
      return `${t.via ?? "sed"} -i in-place edit`;
    case "tee":
      return "tee";
    case "mv-cp-dest":
      return `${t.via ?? "mv/cp"} destination`;
    case "interpreter-script":
      return `${t.via ?? "interpreter"} -c/-e script payload`;
  }
}

function isSensitiveFilename(filename: string, fullPath: string): boolean {
  return (
    filename === ".env" ||
    filename.includes(".env.") ||
    filename === "id_rsa" ||
    filename === "credentials" ||
    (filename === "config" && fullPath.includes(".aws"))
  );
}

/**
 * Checks whether a shell command is safe to execute based on active path safety rules.
 * Flags modifications outside the workspace root and checks for sensitive file access.
 */
export async function isCommandSafe(
  command: string,
  workspaceRoot: string,
): Promise<CommandSafetyResult> {
  const parsed = await parseShellCommand(command);
  const guard = new WorkspaceGuard(workspaceRoot);

  // ── Step 0: shell-side write-target scan ─────────────────────────
  // Catch cat > / sed -i / tee / mv / cp / python -c / heredoc smuggling
  // *before* the per-command AST loop, because tree-sitter strips
  // redirects from the per-command arg list. These are the patterns
  // the agent has historically used to bypass PlatformPathLockedError.
  for (const target of extractWriteTargets(command)) {
    const cleaned = expandHome(stripQuotes(target.path));
    const resolved = path.resolve(workspaceRoot, cleaned);

    // a. Outside workspace? Hard reject.
    if (!guard.isInside(resolved)) {
      return {
        safe: false,
        reason: `Shell write blocked: ${describeKind(target)} targets a path outside the workspace (${target.path})`,
        affectedPath: resolved,
      };
    }

    // b. Inside the platform's own runtime? Hard reject with the
    //    same message the surgical/write tools surface, so the agent
    //    sees an identical signal regardless of which tool it tried.
    try {
      guard.assertNotPlatformPath(resolved);
    } catch (err) {
      if (err instanceof PlatformPathLockedError) {
        return {
          safe: false,
          reason:
            `Shell write blocked: ${describeKind(target)} would modify a Fixo CLI ` +
            `core architecture file (${err.relative}). Use the write_file or ` +
            `surgical_edit tool instead — shell file-writing is sandboxed.`,
          affectedPath: err.resolved,
        };
      }
      throw err;
    }

    // c. Sensitive credential file? Same rules as DANGEROUS_MODIFIERS.
    const filename = path.basename(resolved).toLowerCase();
    if (isSensitiveFilename(filename, resolved)) {
      return {
        safe: false,
        reason: `Shell write blocked: ${describeKind(target)} targets a sensitive credentials file (${filename})`,
        affectedPath: resolved,
      };
    }
  }

  for (const cmd of parsed) {
    const binaryLower = cmd.binary.toLowerCase();
    // Compare per-arg safety checks against the basename so a binary
    // invoked by absolute or relative path (`/bin/rm`, `./scripts/rm`)
    // is still recognised as a dangerous modifier / reader.
    const binBasename = path.basename(unquote(binaryLower)).toLowerCase();

    // Check if the binary itself is a path outside the workspace.
    // Trusted system binaries (git/node/npm/...) bypass this rejection
    // because the agent legitimately needs to invoke its own toolchain,
    // which lives outside the project root. Per-argument file containment
    // is still enforced below.
    if (binaryLower.startsWith("/") || binaryLower.startsWith(".")) {
      const resolvedBin = path.resolve(workspaceRoot, unquote(binaryLower));
      if (
        !guard.isInside(resolvedBin) &&
        !ALLOWED_GLOBAL_BINARIES.has(binBasename)
      ) {
        return {
          safe: false,
          reason: `Attempt to execute an external binary located outside the workspace: ${cmd.binary}`,
          affectedPath: resolvedBin,
        };
      }
    }

    // Identify scaffolders and extract target path
    const scaffolder = KNOWN_SCAFFOLDERS.find((s) => s.bin === binBasename);
    if (scaffolder && scaffolder.isScaffolder(cmd.arguments)) {
      const targetPath = scaffolder.extractTargetPath(cmd.arguments);
      if (targetPath) {
        const cleanArg = unquote(targetPath);
        // Expand home paths
        let targetFullPath = cleanArg;
        if (cleanArg === "~") {
          targetFullPath = os.homedir();
        } else if (cleanArg.startsWith("~/") || cleanArg.startsWith("~\\")) {
          targetFullPath = path.join(os.homedir(), cleanArg.slice(2));
        }
        const resolved = path.resolve(workspaceRoot, targetFullPath);
        if (!guard.isInside(resolved)) {
          return {
            safe: false,
            reason: `Scaffolding command '${cmd.binary}' attempts to create a project outside the workspace root (${targetPath})`,
            affectedPath: resolved,
          };
        }
      }
    } else {
      // Unknown command that might be directory-creating.
      //
      // Phase 1a — the original heuristic flagged every bare positional
      // arg matching /^[a-zA-Z0-9_-]+$/ as "looks like a new directory".
      // Two bugs:
      //   1. Standard POSIX inspection tools (`find`, `awk`, `sed`, etc.)
      //      were not in the non-scaffolder allowlist, so they fell into
      //      this branch.
      //   2. Value-args of known flags (`-type f`, `-name foo`) were
      //      treated as positional. `find . -type f` flagged `f` as a
      //      new directory name. Comically wrong; observed in the
      //      June 22, 2026 log session.
      //
      // Fix: extend the allowlist for tools known never to create
      // directories from a bare arg, AND strip value-args of known
      // value-taking flags before computing positionals.
      const COMMON_NON_SCAFFOLDERS = new Set([
        "echo",
        "git",
        "node",
        "npm",
        "npx",
        "yarn",
        "pnpm",
        "bash",
        "sh",
        "cat",
        "grep",
        "mkdir",
        "rm",
        "ls",
        "cd",
        "pwd",
        "mv",
        "cp",
        "touch",
        "python",
        "python3",
        "go",
        "cargo",
        "docker",
        "docker-compose",
        // Phase 1a additions — standard POSIX inspection/transform tools
        // that take bare args as filters or input files, never as new
        // directory targets.
        "find",
        "awk",
        "sed",
        "xargs",
        "jq",
        "tar",
        "head",
        "tail",
        "sort",
        "uniq",
        "wc",
        "tr",
        "cut",
        "tee",
        "less",
        "more",
        "file",
        "stat",
        "basename",
        "dirname",
        "readlink",
        "which",
        "whereis",
      ]);
      if (
        !COMMON_NON_SCAFFOLDERS.has(binBasename) &&
        !DANGEROUS_MODIFIERS.has(binBasename) &&
        !DANGEROUS_READERS.has(binBasename) &&
        cmd.arguments.length > 0
      ) {
        const positionalArgs = stripFlagValues(cmd.arguments);
        if (positionalArgs.length > 0) {
          const lastArg = unquote(positionalArgs[positionalArgs.length - 1]);
          if (
            lastArg.match(/^[a-zA-Z0-9_-]+$/) &&
            !lastArg.startsWith("./") &&
            !lastArg.startsWith("/") &&
            !lastArg.startsWith("~")
          ) {
            return {
              safe: false,
              reason: `Command '${cmd.binary}' looks like it might create a new directory ('${lastArg}'). Please confirm execution.`,
              affectedPath: path.resolve(workspaceRoot, lastArg),
            };
          }
        }
      }
    }

    for (const arg of cmd.arguments) {
      if (arg.startsWith("-")) continue;

      const cleanArg = unquote(arg);
      const looksLikePath =
        cleanArg.includes("/") ||
        cleanArg.includes("\\") ||
        cleanArg.includes(".") ||
        cleanArg === "~";
      if (!looksLikePath) continue;

      // Expand home paths
      let targetPath = cleanArg;
      if (cleanArg === "~") {
        targetPath = os.homedir();
      } else if (cleanArg.startsWith("~/") || cleanArg.startsWith("~\\")) {
        targetPath = path.join(os.homedir(), cleanArg.slice(2));
      }

      const resolved = path.resolve(workspaceRoot, targetPath);

      // Check for workspace escaping
      if (DANGEROUS_MODIFIERS.has(binBasename)) {
        if (!guard.isInside(resolved)) {
          return {
            safe: false,
            reason: `Command '${cmd.binary}' attempts to write or delete files outside the workspace root`,
            affectedPath: resolved,
          };
        }
      }

      // Check for sensitive credential files
      const filename = path.basename(resolved).toLowerCase();
      const isSensitive =
        filename === ".env" ||
        filename.includes(".env.") ||
        filename === "id_rsa" ||
        filename === "credentials" ||
        (filename === "config" && resolved.includes(".aws"));

      if (isSensitive) {
        if (DANGEROUS_MODIFIERS.has(binBasename)) {
          return {
            safe: false,
            reason: `Command '${cmd.binary}' attempts to modify a sensitive credentials file: ${filename}`,
            affectedPath: resolved,
          };
        }
        if (DANGEROUS_READERS.has(binBasename) || binBasename === "grep") {
          return {
            safe: false,
            reason: `Command '${cmd.binary}' attempts to read a sensitive credentials file: ${filename}`,
            affectedPath: resolved,
          };
        }
      }
    }
  }

  return { safe: true };
}

// ──── Backwards-compatible exports ───────────────────────────────

/**
 * @deprecated Direct tree-sitter initialisation is no longer required.
 * `parseShellCommand` now handles initialisation internally via the
 * `ParserFactory` singleton. This export is kept for callers that still
 * need to explicitly warm the parser at startup; it is a no-op once
 * the factory has already initialised.
 */
export async function initTreeSitter(): Promise<void> {
  await ParserFactory.getParser();
}
