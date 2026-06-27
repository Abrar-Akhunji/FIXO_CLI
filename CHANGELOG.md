# Changelog

All notable changes to FixO CLI will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/).

---

## [1.0.4] – 2025-06-26

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
