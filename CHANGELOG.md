# Changelog

All notable changes to FixO CLI will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

Working tree after tagged `1.0.8`. Includes `9b48e2e` (codebase stabilization, UI cleanup, and test suite updates) and the fixes below. Not committed or published.

### Fixed
- Tool success is a boolean on `ToolCallEvent`. The spinner, the dashboard, and worker telemetry use it, so a non-zero exit, a signal, a patch failure, or a cancelled tool is no longer shown as success.
- Verification commands map a timeout or a null status to status 1. Auto-verify no longer treats that as a pass.
- Project memory uses `node:sqlite` when it exists and a JSON file store (`memory.file.json`) when it does not, including Node 20. `FIXO_MEMORY_BACKEND=file` forces the file store.
- `spawn_subagent` inherits model, policy, yes, and verbose. `Explore` runs in EXPLORE, `Plan` in PLAN, and `general-purpose` and `statusline-setup` stay in BUILD.
- Worktree annotations in assistant text are applied in BUILD mode and stripped before the text is shown or stored. Read-only modes strip them and do not run git.
- Explanatory tasks that only mention a change, update, or add stay read-only. An imperative mutation still selects BUILD.
- `read_file`, `write_file`, and `delete_file` share one sensitive-path check, including `.ssh`, credentials, `authorized_keys`, and `.key` files.
- The background-job success test polls until the process exits.
- Removed the duplicate `engines` key in `package.json`.
- `scripts/check-model-registry.js` accepts single- or double-quoted registry entries.

### Documentation
- README no longer lists tree-sitter repo map, auto-verify, model routing, or the complexity classifier as unfinished.
- README, SAFETY, and the staging comment no longer advertise `/fixo gc`, `fixo providers`, or `fixo config reset`. The live REPL command is `/providers`.

## [1.0.8] – 2026-06-28

### Changed
- Cleanup of unused variables and formatting for the 1.0.8 tag.

## [1.0.7] – 2026-06-27

### Changed
- Default FreeLLMAPI endpoint moved to freellm-for-fixo.
- Legacy config `apiUrl` values migrate to that endpoint.

## [1.0.6] – 2026-06-27

### Fixed
- Workspace guard, LSP manager, and string-replace tool behavior.

### Changed
- Production cleanup and a smaller npm payload.

## [1.0.5] – 2026-06-27

### Added
- Direct-provider BYOK is the default. The FreeLLMAPI proxy is opt-in.
- Opt-in OS sandbox for `run_command`.
- Task router with a live LLM complexity classifier and a keyword short-circuit.
- Automatic post-edit verification in the single-agent loop.
- Local fast, heavy, and default model substitution via `preferences.modelRouting`.
- Tree-sitter symbol extraction in the repo map for TypeScript, JavaScript, Python, Go, and Rust, with configurable walk caps.
- LSP cross-file references for pinned files.
- Partial-work preservation when a worker pool fails, and DAG write-set conflict detection.
- CI and ESLint gates.
- Manual model-registry check script.

### Fixed
- Orchestrator rollback is limited to files the worker touched.

### Removed
- Dead planner façade.

## [1.0.4] – 2026-06-11

### Security
- **decryptKey** now throws on AES-256-GCM decryption failure instead of silently returning ciphertext, preventing corrupted keys from being used as live credentials.
- `getOrCreateRunId()` switched from `Math.random()` to `crypto.randomBytes(6)` for cryptographically secure staging-directory namespace IDs.
- `RETRYABLE_STATUS_CODES` in `agent-client.ts` now includes `504` (Gateway Timeout), matching the canonical set in `retry.ts`.

### Bug Fixes
- Fixed a duplicate `name === 'AbortError'` condition in `defaultIsRetryable` (dead-code bug in `retry.ts`).
- `SIGINT` handler is now deduplicated when both the readline interface and the process fire simultaneously.
- `buildLavaStatusState()` now derives the `transport` field from the actual `provider_mode` config instead of always displaying `'freellmapi'`.
- `getOrCreateRunId()` uses canonical `MUTATION_TOOL_NAMES` set instead of a fragile string-heuristic for mutating action detection.

### Improvements
- Non-null assertions (`!`) in setup-wizard provider registry lookups replaced with proper runtime guards.
- Removed dead empty section headers from `src/ui/prompt.ts`.
- Simplified `buildLavaStatusState()` ternary chain (removed unreachable `else` branch).
- Removed unused `width` variable from `drawSuggestions()`.
- Silent `catch {}` in `exitCleanup` now logs in debug/verbose mode.
- Trailing whitespace removed from `retry.ts`.

### Packaging
- Added `"exports"` field to `package.json` for proper ESM resolution.
- Added `postinstall` script to enforce Node.js >= 20.0.0 at install time.
- `CHANGELOG.md` added to published `files` list.

---

## [1.0.3] – 2025-06-20

### Added
- Atomic staging pipeline with rollback (`AtomicStagingManager`).
- LSP pre-save gate (Pillar 3) for syntax validation before disk writes.
- Semantic loop detector (`SemanticLoopDetector`) to complement hash-based loop trap.
- `run_command_async` / `poll_command_status` / `kill_command` tools for long-running tasks.
- `glob_files` tool using Node.js 22+ native `fs.promises.glob`.

### Security
- AES-256-GCM encryption for API keys at rest in `providers.json`.
- `WorkspaceGuard.assertNotPlatformPath()` prevents agent from modifying its own source files.
- `SCRUB_PATTERNS` expanded to cover OpenAI, Anthropic, OpenRouter, GitHub, Google, AWS, and JWT tokens.
- Provider credential vault (`ProviderKeyVault`) with scoped `withApiKey` callbacks.

---

## [1.0.0] – 2025-05-01

### Added
- Initial release of FixO CLI.
- Multi-provider support: OpenAI, Anthropic, Groq, Google, Mistral, Together, Perplexity, DeepSeek, Cohere, OpenRouter, NVIDIA, xAI, GitHub Models, Ollama, Zen.
- FreeLLMAPI proxy mode with load-balanced failover.
- Interactive setup wizard (`/setup`).
- Loop-trap detection, atomic writes, LSP integration.
- REPL with slash commands, autocomplete, paste attachments, and session history.
