/**
 * file-writing-rules.ts — Shared system-prompt fragment that steers
 * the LLM toward the sanctioned write tools and away from shell-based
 * file mutation.
 *
 * The shell sandbox (see `command-parser.ts` → `extractWriteTargets`)
 * already rejects `cat > file`, `sed -i`, `tee`, `mv` into platform
 * paths, `python3 -c "open(...,'w')"`, and heredoc smuggling. But a
 * rejection still costs a turn and an approval prompt. This block
 * tells the model up-front not to try, so the typical session never
 * floods the user with security warnings the way Test 1 in the log
 * did.
 *
 * Keep this fragment short: every agent persona that gets tool
 * access (single-agent, code worker, test worker) pastes it into
 * its system prompt.
 */
export const FILE_WRITING_RULES_BLOCK = [
  ``,
  `## File Writing Rules (HARD CONSTRAINT)`,
  `The ONLY sanctioned tools for writing files are \`write_file\`, \`str_replace\`, \`apply_patch\`, \`replace_range\`, \`insert_after\`, and \`rename_file\`. They are atomic, LSP-gated, and respect the platform path lock.`,
  `Writing files via \`run_command\` is **sandbox-blocked**. The following patterns will be rejected with a security error and waste a tool call:`,
  `- \`cat > file\`, \`cat >> file\`, \`echo … > file\`, or any \`>\`/\`>>\` redirect that writes a workspace file`,
  `- heredocs like \`cat > file <<'EOF' … EOF\` or \`python3 << 'PYEOF' … PYEOF\``,
  `- \`tee\`, \`sed -i\`, \`perl -i\`, \`awk … > file\``,
  `- \`mv\`/\`cp\` whose destination is a tracked source file`,
  `- interpreter payloads that write: \`python3 -c "open('x','w')…"\`, \`node -e "fs.writeFileSync('x', …)"\`, \`perl -e "open(FH,'>','x')…"\``,
  `Target paths must NEVER be blank, empty, or evaluate to the directory root (e.g. \`.\`). Always specify the exact file name (e.g. \`path/to/file.ts\`). Writing to a blank path will fail with an EISDIR error.`,
  `If you find yourself reaching for any of these, stop and use \`write_file\` (or \`str_replace\`/\`apply_patch\` for edits) instead — it is faster, safer, and the only path that actually succeeds.`,
  `\`run_command\` is for running things (tests, builds, git, lint, format), not for producing files.`,
].join("\n");
