# Operational Safety & Enterprise Hardening

> **Status:** Production-ready · 234/234 tests passing · Pillar 1–4 landed

This document specifies the **threat model** and **safety
architecture** of the four independent safety layers that ship
in the Phase 2 hardening release. It is intended for security
reviewers, platform engineers, and contributors extending the
system with new write tools, new providers, or new LLM clients.

For the resilience layer (uptime, retries, context budgeting,
telemetry) see [`docs/RESILIENCE.md`](RESILIENCE.md). Safety and
resilience are deliberately orthogonal:

- **Resilience** keeps the system **alive** through network
  noise, rate limits, and partial failures.
- **Safety** keeps the system from **corrupting the user's
  workspace** or **leaking credentials**.

---

## 1. Threat Model

Fixo CLI executes untrusted LLM-generated tool calls against a
developer workstation. The realistic threat surface is:

| # | Threat | Impact | Mitigation |
|---|--------|--------|------------|
| T1 | LLM enters a degenerate loop, re-issuing equivalent tool calls and burning tokens / rate-limit budget. | Slow session, silent cost overrun, provider cooldown. | **Pillar 1** — `LoopTrapDetector` |
| T2 | Process killed mid-`writeFileSync` leaves a half-written source file. | Build broken, user loses work. | **Pillar 2** — `AtomicStagingManager` |
| T3 | LLM emits a "looks valid" TypeScript file with undefined references or wrong import paths. | Silent corruption, hard-to-bisect regressions. | **Pillar 3** — `LspPreSaveGate` |
| T4 | Direct-provider API key leaks into a tool result, an error message, a log line, or a model prompt. | Account takeover, billing exposure. | **Pillar 4** — `ProviderKeyVault` + `scrubForLlm` |
| T5 | External command output or fetched URL contains a secret. | Same as T4. | **Pillar 4** — `scrubForLlm` upgrade |
| T6 | Old staged writes accumulate under `.fixo/staging/` and silently bloat the user's disk. | Disk fill. | **Pillar 2** — `garbageCollectAll` |

### Out of scope (by design)

- **Malicious code execution** — handled by `policy.ts` shell
  confirmation, separate from this layer.
- **LLM output quality** — no amount of safety plumbing will
  fix a bad prompt.
- **Filesystem full / ENOSPC** — surfaced as a normal error;
  Pillar 2's staging will fail loudly rather than corrupt.

---

## 2. Safety Architecture Overview

```
                        ┌──────────────────────────────┐
                        │  SingleAgent.runStreaming()  │
                        └──────────────┬───────────────┘
                                       │
        ┌──────────────────────────────┼─────────────────────────────────┐
        │                              │                                 │
        ▼                              ▼                                 ▼
 ┌───────────────┐            ┌────────────────┐               ┌──────────────────┐
 │ LoopTrapDetect│            │ AtomicStaging  │               │ ProviderKeyVault │
 │   (Pillar 1)  │            │  (Pillar 2)    │               │   (Pillar 4)     │
 └──────┬────────┘            └────────┬───────┘               └────────┬─────────┘
        │                              │                                 │
        │  3x composite repeat?        │  stage → pre-commit hook →      │  withApiKey(...)
        │  → inject [Loop-Trap]        │  commit (atomic rename)         │  scoped callback
        │    directive + compact       │                                 │
        │  6x composite repeat?        │       │                         │
        │  → throw LoopTrapAbortedError│       ▼                         │
        └──────────────────────────────┤  LspPreSaveGate (Pillar 3)      │
                                       │  - off  : no-op                 │
                                       │  - warn : log diagnostics,      │
                                       │          allow commit            │
                                       │  - block: throw on error-sev,   │
                                       │          AtomicStagingManager   │
                                       │          rolls back via .bak     │
                                       └─────────────────────────────────┘
```

The four pillars are **independent** — any one of them can be
disabled via `preferences.safety` without affecting the others.

---

## 3. Pillar 1 — `LoopTrapDetector` (Deterministic Loop-Trap Defenses)

`src/runtime/loop-trap.ts`, re-exported through `src/planner.ts`.

### 3.1 The repetition problem

An LLM can enter a degenerate strategy where it re-issues the
same tool call (or near-equivalent) turn after turn. The legacy
agent loop has no memory of prior turns beyond the conversation
history, so it cannot detect that the strategy has stopped
working. The model burns tokens, the user burns time, the
provider's rate-limit budget drains, and the workspace is
unchanged.

### 3.2 Cryptographic deterministic fingerprinting

The detector computes three independent `sha256` fingerprints
per turn, then takes the `sha256` of their concatenation as the
**composite fingerprint**. A turn is "equivalent" to the
previous one only if **all three** fingerprints match — a
single divergent layer breaks the chain.

#### Layer 1 — `toolCallFingerprint`

The tool-call argument object is canonicalised before hashing:

1. Keys are sorted lexicographically (via `Object.keys(...).sort()`).
2. `undefined` values are dropped.
3. The result is `JSON.stringify`-ed.
4. The output is hashed with `sha256` (hex digest, 64 chars).

Two calls with the same logical arguments produce the same
fingerprint regardless of property order:

```ts
canonicaliseArgs({ file: 'a.ts', line: 12 })
  === canonicaliseArgs({ line: 12, file: 'a.ts' })
```

#### Layer 2 — `toolResultFingerprint`

A naive hash of the full tool result would over-trigger on
benign changes (timestamps, progress counters, LSP diagnostic
timestamps, deprecation notices appended by the runtime). The
detector hashes only the **tail**:

```
tail = result.slice(-toolResultTailBytes)   // default 1024
fingerprint = sha256(tail)
```

Two tool outputs that share the same 1024-byte suffix produce
the same fingerprint even if their prefixes differ. This makes
the detector robust against the "noisy" output that large
language models and LSPs tend to add.

#### Layer 3 — `workspaceFingerprint`

The detector walks the workspace rooted at `cwd`, excludes
`node_modules`, `.git`, `.fixo`, `dist`, `.next`, `out`,
`build`, `coverage`, `.cache`, `.turbo`, and any caller-
supplied `extraExclude` basenames, then for each file:

1. Compute `rel = path.relative(cwd, full)`.
2. Compute `h = sha256(content, 'binary')`.
3. Push `[rel, h]` into an array.

The array is sorted by `rel` (lexicographic), joined as
`${rel}\t${h}\n`, and the joined string is hashed.

The walk is bounded by a 100,000-file cap and skips symlinks
(via `lstatSync`) to prevent recursion attacks. Binary files
are hashed as raw bytes; this is safe because the hash is
deterministic and we are comparing equivalence, not
content-type.

### 3.3 Composite fingerprint

```
composite = sha256(
  toolCallFingerprint +
  toolResultFingerprint +
  workspaceFingerprint
)
```

A turn is "equivalent to the previous turn" iff all three
layer fingerprints match. The detector counts the longest
suffix of the history where every turn is equivalent, and
returns one of three verdicts:

| Verdict | Threshold (default) | Action |
|---|---|---|
| `ok` | < 3 consecutive equivalents | Continue normally. |
| `trap-detected` | ≥ 3 consecutive | Inject `[Loop-Trap]` system directive + force conversation compaction. |
| `hard-abort` | ≥ 6 consecutive | Throw `LoopTrapAbortedError`. The agent loop terminates. |

### 3.4 Why all three layers are required

A one-layer detector has a fatal false-positive class:

- **Tool-args only** — a legitimate `read_file` of the same
  100-line file across 3 turns (read → patch → verify) trips
  the trap.
- **Workspace only** — a read-only inspection task (e.g.
  `cat` of the same log file) trips the trap.

The composite of all three layers discriminates "the agent is
doing the same thing and getting the same result on the same
on-disk state" from "the agent is iterating on a multi-step
task". In the read→patch→verify example, the tool args differ
across turns (`read_file` vs `apply_patch` vs `run_command`)
even if the read content is the same, so the composite
fingerprint changes and the trap does not fire.

### 3.5 Operator interface

```ts
import { LoopTrapDetector, DEFAULT_LOOP_TRAP_PREFS } from './runtime/loop-trap.js';

const detector = new LoopTrapDetector();
const verdict = detector.record({
  turnIndex: 0,
  toolCallFingerprint: detector.fingerprintToolCall(args),
  toolResultFingerprint: detector.fingerprintToolResult(toolOutput),
  workspaceFingerprint: await detector.fingerprintWorkspace(cwd),
  ts: new Date().toISOString(),
});

if (verdict.state === 'trap-detected') {
  // inject [Loop-Trap] directive into the system prompt
  conversation.addSystemMessage(LOOP_TRAP_DIRECTIVE);
  await conversation.compact();
} else if (verdict.state === 'hard-abort') {
  throw new LoopTrapAbortedError(verdict.fingerprint, verdict.consecutiveCount);
}
```

`planner.ts` re-exports the entire surface (`LoopTrapDetector`,
`LoopTrapAbortedError`, `canonicaliseArgs`, `DEFAULT_LOOP_TRAP_PREFS`,
and the type union) so downstream callers do not import from
`runtime/` directly.

### 3.6 Threat-model coverage

- ✅ Detects three common degenerate patterns: identical
  tool-call spam, identical-no-output loops, and
  writes-that-keep-failing.
- ✅ Resilient to benign output noise (tail hashing).
- ✅ Resilient to large multi-step edits (three-layer
  composite).
- ⚠️ Does **not** detect a strategy that makes *meaningful
  progress on a different file each turn*. The composite
  fingerprint will change; the detector will not fire. This
  is by design — the workspace has changed, the agent is
  doing real work.

---

## 4. Pillar 2 — `AtomicStagingManager` (Shadow Staging)

`src/runtime/staging.ts`.

### 4.1 The non-atomic write problem

`fs.writeFileSync(target, content)` is a single syscall on the
POSIX `write(2)` path, but it is **not atomic** in the kernel
sense. If the process is killed mid-write, the file is left
truncated. If the process is killed between the truncate and
the content-fill, the user has a zero-byte source file. A
multi-file patch sequence (e.g. `replace_range` then
`apply_patch`) compounds the risk: a failure mid-sequence
leaves the workspace in a state that may not even compile.

### 4.2 Shadow staging lifecycle

Every file write routed through the executor now goes through
this pipeline:

```
   applyAtomicWrite(filePath, content, safety, session)
                  │
                  ▼
   ┌──────────────────────────────────────────────┐
   │ stage(target, content)                       │
   │   • mkdir .fixo/staging/<runId>/  (mode 700) │
   │   • write .pending            (mode 600, tmp+rename)
   │   • write .meta.json          (mode 600)
   └──────────────────────┬───────────────────────┘
                          ▼
   ┌──────────────────────────────────────────────┐
   │ preCommitHook(entry)     ◄── Pillar 3 LSP gate
   │   • gate.check(entry) → diagnostics          │
   │   • gate.enforce(result, entry)              │
   │     ├─ mode 'off'   : no-op                  │
   │     ├─ mode 'warn'  : log, allow commit      │
   │     └─ mode 'block' : throw on error-sev     │
   └──────────────────────┬───────────────────────┘
                          │ (hook returns normally)
                          ▼
   ┌──────────────────────────────────────────────┐
   │ commit(id)                                   │
   │   1. mkdir parent of target                  │
   │   2. if target exists → rename to .pending.bak│
   │   3. rename .pending → target   (POSIX atomic)│
   │   4. chmod target to entry.mode              │
   │   5. unlink .pending.bak                     │
   │   6. unlink .meta.json                       │
   └──────────────────────┬───────────────────────┘
                          │
                          ▼
                  target updated atomically
                  no leftover .pending.bak or .meta.json
```

### 4.3 POSIX atomic-replacement constraints

`fs.renameSync(oldPath, newPath)` is atomic on POSIX only if
both paths are on the **same filesystem**. The staging
directory is created at `<cwd>/.fixo/staging/<runId>/` —
guaranteed to be on the same filesystem as the target because
it is a descendant of `cwd`. The staging layout is:

```
<cwd>/.fixo/staging/<runId>/<sha256(target)>.pending
<cwd>/.fixo/staging/<runId>/<sha256(target)>.meta.json
<cwd>/<target>                        ◄── the user's file
<cwd>/<target>.pending.bak            ◄── only present mid-commit
```

`<runId>` is sanitised to `[A-Za-z0-9._-]+` to prevent path
traversal. `<sha256(target)>` is a 64-char hex digest of the
realpath-resolved absolute target path; it is collision-free
and free of special characters.

### 4.4 Rollback on failure

If any step of `commit()` throws (e.g. Pillar 3's LSP gate
rejects in `block` mode), the staging manager:

1. If `<target>.pending.bak` exists, renames it back to
   `<target>`. The user's original file is restored byte-for-byte.
2. If the target did not exist before and the swap partially
   succeeded, the target is left in whatever state the kernel
   reached and the user is informed via the
   `PreCommitHookRejectedError`'s `cause` field.

The `.pending` and `.meta.json` files are always cleaned up on
success, so a successful run leaves zero residue under
`.fixo/staging/`.

### 4.5 Garbage collection

Two sweeps keep the staging directory from silently bloating:

| Sweep | Trigger | Behaviour |
|---|---|---|
| `mgr.gc(now?)` | Per-run, called at the end of a streaming cycle. | Walks `<stagingDir>/`, removes entries with `createdAt < now - ttlMs`. Default TTL is **24 hours**. |
| `AtomicStagingManager.garbageCollectAll(cwd, ttlMs?)` | Auto-invoked at the **start** of every `runStreaming` lifecycle, in <2ms typical. Also exposed via `/fixo gc` (commit 10 in the Phase 2 plan). | Walks `<cwd>/.fixo/staging/*/`, delegates to `gc()` for each run-id directory. |

GC uses the `.meta.json` `createdAt` field (timestamp) rather
than file mtime so the TTL is a deterministic policy decision,
not a side effect of when the kernel flushed the inode.

### 4.6 Failure modes and operator responses

| Symptom | Cause | Fix |
|---|---|---|
| `StagedWriteNotFoundError` on `commit(id)` | Stale `id` (entry was already committed or GC'd). | Idempotent: caller can ignore and retry. |
| `StagingPathEscapeError` on `stage(target, content)` | Target escapes the workspace root (`../`-prefixed). | Caller bug — the WorkspaceGuard rejected it. |
| `PreCommitHookRejectedError` | The LSP gate (or a future pre-commit hook) rejected the write. | Inspect the `cause` field; original file is preserved. |
| `LspPreSaveBlockedError` (as `cause`) | Pillar 3 saw an `error`-severity diagnostic. | Read the diagnostics summary in the error message; fix the code and re-run. |

### 4.7 Threat-model coverage

- ✅ Process kill mid-write leaves the original file intact.
- ✅ Failed Pillar 3 check rolls back without touching the
  target.
- ✅ Stale staged writes are auto-GC'd, preventing disk
  fill.
- ⚠️ Cross-filesystem targets (e.g. a symlink pointing to a
  different mount) will cause `EXDEV` from `renameSync`. The
  WorkspaceGuard does not currently block symlinks at the
  target path; this is a known limitation tracked for the
  next release.

---

## 5. Pillar 3 — `LspPreSaveGate` (Live Pre-Save Compilation Check)

`src/lsp/lsp-pre-save.ts`.

### 5.1 The "looks fine" write

An LLM can produce syntactically valid TypeScript that is
semantically broken: undefined references, wrong import paths,
type errors, unused variables flagged as errors by the project's
tsconfig. Without a static check, the file is written, the test
runner is invoked, and the user spends a turn debugging an
error that could have been caught at write-time.

### 5.2 Mode policy

The gate has three modes, controlled by `preferences.safety.lspPreSave`:

| Mode | Behaviour | When to use |
|---|---|---|
| `off` | No-op. The provider is not even called. | You are prototyping, you have no language server installed, or you trust the LLM's output. |
| `warn` | Diagnostics are collected; if any are present, they are logged to the console and a telemetry event is recorded. The commit proceeds. | You want soft feedback without blocking. Recommended for fast iteration. **Default.** |
| `block` | If any `error`-severity diagnostic is present, the gate throws `LspPreSaveBlockedError`. The staging manager catches this in its `preCommitHook` and rolls back the swap. The user's original file is preserved. | You are running in CI, refactoring across many files, or trusting the LLM less than the language server. |

`warn` and `block` are different from the LLM's perspective:

- `warn` is **invisible** to the LLM — it does not change the
  tool result. The user sees the diagnostics, the LLM does not.
- `block` is **visible** to the LLM — the tool returns an
  error string containing the first 3 error messages, the LLM
  sees them, and the next turn's strategy is forced to address
  them.

### 5.3 Bypass behaviour

The gate is a pass-through when no language server is installed
on `PATH`. This matches the existing `LspManager` behaviour: if
`typescript-language-server`, `pyright-langserver`, `gopls`, or
`rust-analyzer` is not present, the user sees a one-time warning
at startup and the gate silently no-ops. The agent loop is not
blocked by a missing optional dependency.

The provider call is bounded by a **500ms hard timeout** (configurable
via `timeoutMs`). A hung language server never blocks the
agent loop. On timeout, the gate returns
`{ state: 'no-language-server' }` and the commit proceeds.

### 5.4 Adapter (`makeLspProvider`)

The gate is decoupled from `LspManager` via a `LspDiagnosticsProvider`
function:

```ts
type LspDiagnosticsProvider = (filePath: string) => Promise<LspDiagnostic[]>;
```

Production code constructs one with `makeLspProvider(lspManager)`,
which wraps the existing `LspManager.getClientAndSync` and
`LspClient.getDiagnostics` calls. Tests inject a mock provider
that returns canned data without spawning a real language
server.

### 5.5 Diagnostic normalisation

Raw LSP `Diagnostic` payloads are `any` in the LSP spec. The
gate normalises them into a typed shape:

```ts
interface LspDiagnostic {
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  line: number;
  column: number;
  source: string;
  code: string | number | null;
}
```

`normaliseSeverity(int)` maps the LSP `DiagnosticSeverity`
integer (1=error, 2=warning, 3=info, 4=hint) to a string
literal. `normaliseDiagnostic(raw)` defensively handles null,
non-object, and partial inputs so a malformed payload from a
buggy language server never crashes the staging pipeline.

### 5.6 Operator interface

```ts
const gate = new LspPreSaveGate({
  mode: 'block',                              // 'off' | 'warn' | 'block'
  provider: makeLspProvider(lspManager),     // or a mock for tests
  timeoutMs: 500,
  onResult: (result, entry) => {
    if (result.state === 'diagnostics') {
      recordTelemetry(telemetry.lspDiagnostics({
        file: entry.targetPath,
        errorCount: result.errorCount,
      }));
    }
  },
});

const mgr = new AtomicStagingManager(cwd, runId, {
  preCommitHook: async (entry) => {
    const result = await gate.check(entry);
    gate.enforce(result, entry);     // throws in 'block' mode
  },
});

const entry = mgr.stage('src/foo.ts', 'broken code');
await mgr.commit(entry.id);          // throws LspPreSaveBlockedError
                                      // original file preserved
```

### 5.7 Threat-model coverage

- ✅ Catches `error`-severity TypeScript / Python / Go / Rust
  diagnostics before they hit the user's disk.
- ✅ Bounded latency — never blocks the agent loop longer
  than `timeoutMs`.
- ✅ Zero-config when no language server is installed.
- ⚠️ Does not catch runtime errors, logical bugs, or
  integration issues. The test runner (Pillar of resilience,
  not safety) is the right tool for those.

---

## 6. Pillar 4 — `ProviderKeyVault` (Restricted Credential Sandboxing)

`src/runtime/credential-vault.ts`, with the upgraded pattern
catalogue in `src/runtime/redaction.ts`.

### 6.1 The credential-leakage problem

Direct-provider keys (OpenAI, Anthropic, OpenRouter, Google,
AWS, GitHub) are long-lived secrets with catastrophic blast
radius. The legacy `ProvidersManager.getDirectConfig(name)`
returned a plain object containing the raw key — every caller
that touched that object put the key on its stack, in any
error message, in any `console.log` statement, and in any
crash dump that included a stack trace.

### 6.2 The memory-isolation contract

`ProviderKeyVault` owns the credentials in a **private**
`Map<string, ProviderCredential>` and exposes them
**exclusively** inside a scoped executor block:

```ts
// ❌ NEVER POSSIBLE — there is no such method
vault.getApiKey('openai');          // compile error
vault.peek('openai');               // compile error
JSON.stringify(vault);              // returns {} — no PII leaks

// ✅ ONLY WAY — the key is reachable inside the callback
await vault.withApiKey('openai', (key) => {
  headers.Authorization = `Bearer ${key}`;
  return fetch(url, { headers });
});
// `key` is no longer in scope; it cannot be captured into a
// wider variable, cannot be thrown, cannot be logged.
```

The `#store: Map<string, ProviderCredential>` field is marked
`readonly` and uses TypeScript's `#private` field syntax for
**runtime** privacy (a class consumer cannot reach it via
`Reflect.ownKeys` tricks). The `ProviderCredential` object is
itself constructed inside the `ingest` method and the
`#store.set` call; the constructor never returns a reference
to a caller.

### 6.3 Scoped-context execution loops

Two patterns are provided, both with the same security
guarantees:

| Method | Signature | Use case |
|---|---|---|
| `withApiKey(name, fn)` | `fn: (key: string) => Promise<T> \| T` | Building a request that only needs the Authorization header. |
| `withApiKeySync(name, fn)` | sync only — throws if `fn` returns a `Promise` | Sync header construction; catches accidental `await`. |
| `withCredential(name, fn)` | `fn: (cred: ProviderCredential) => Promise<T> \| T` | Building a request that needs the key **and** the base URL / display name. |
| `buildAuthHeaders(name, builder)` | `builder: (cred) => Record<string, string>` | The common "header-only" path, with a typed return value. |

All four throw `ProviderNotInVaultError` synchronously if the
provider is not configured. The callback is never invoked with
a missing provider.

### 6.4 What is *not* exposed

- `getApiKey(name)` — does not exist.
- `peek(name)` — does not exist.
- `toJSON()` — not implemented; `JSON.stringify(vault)` returns
  `{}`.
- `[Symbol.iterator]` — not implemented; the vault is opaque
  to iteration.
- The `Map` is `#private` — `Reflect.ownKeys(vault)` shows only
  the `size()` result and the public methods.

The only introspection surface is **metadata**:

```ts
vault.hasProvider(name);      // boolean
vault.size();                 // number of configured providers
vault.listProviderNames();    // sorted string[]
```

None of these leak a key.

### 6.5 Vault lifecycle

```
  ProvidersManager.add(name, key)
        │
        ▼
  providers.json (mode 0600)
        │
        ▼
  getProviderKeyVault().ingest(name, key, baseUrl, displayName)
        │
        ▼
  Private #store has the key.
  `withApiKey` is now the only escape hatch.
```

- `ProvidersManager.add(name, key)` writes to disk and calls
  `ingest()` on the vault — they stay in sync.
- `ProvidersManager.remove(name)` deletes from disk and calls
  `vault.evict(name)` — the key is unreachable.
- On the first call to `ProvidersManager.getDirectConfig(name)`,
  the vault is hydrated from disk (idempotent). New keys added
  via `add()` are immediately visible without a restart.

### 6.6 `scrubForLlm` — defence-in-depth

Even with the vault, an LLM prompt might still receive a
secret via a tool result (a `cat ~/.bashrc` output, a fetched
URL with embedded keys, etc.). The upgraded `scrubForLlm`
function is the second line of defence, with patterns for:

| Provider | Pattern |
|---|---|
| OpenAI | `sk-...`, `sk-proj-...`, `sk-svcacct-...` |
| Anthropic | `sk-ant-api03-...`, `sk-ant-...` |
| OpenRouter | `sk-or-v1-...`, `sk-or-...` |
| Google | `AIzaSy...`, GCP service-account `private_key` PEM blocks |
| AWS | `AKIA[0-9A-Z]{16}`, `ASIA[0-9A-Z]{16}`, `aws_secret_access_key=`, `aws_session_token=`, `secret_access_key=` |
| GitHub | `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_` |
| Slack | `xox[baprs]-...` |
| Stripe | `sk_live_...`, `rk_live_...` |
| JWT | `eyJ...eyJ...xxx` (three-segment) |
| HTTP | `Bearer <token>`, `Token <token>` |
| Generic | `api_key=...`, `secret=...`, `token=...`, `password=...` |

`scrubForLlm` strips ANSI escapes first, then runs every
pattern, replacing matches with `[REDACTED]`. Patterns are
**deliberately conservative** — they err on false positives
(over-redaction) over false negatives (leakage). The
downstream cost of a false positive is a `[REDACTED]` token
in a tool result; the downstream cost of a false negative is
a leaked credential.

The legacy `redactSecrets` is preserved as a `@deprecated`
alias that delegates to `scrubForLlm`, so existing callers
automatically inherit the expanded catalogue.

### 6.7 Threat-model coverage

- ✅ API key is never in a function return value, error
  payload, log line, or model prompt.
- ✅ A misbehaving consumer cannot enumerate, serialise, or
  iterate the vault.
- ✅ External tool output is scrubbed before being fed into
  the model.
- ✅ Direct child processes (`run_command`) inherit a
  redacted `process.env` via `redactedEnv()`, which strips
  `^fixo_`, `^anthropic_`, `^openai_`, `^google_`, `^aws_`,
  `^openrouter_`, `^github_`, `*_secret`, `*_key`,
  `*_password`, `*_token`.
- ⚠️ Does not protect against a malicious language model
  that intentionally exfiltrates via outbound network calls
  — that is a separate concern handled by `policy.ts`.

---

## 7. `preferences.safety` Configuration Schema

Persisted at `~/.fixocli/config.json` under the `preferences`
key. The `safety` block is **orthogonal** to `resilience` —
mixing them would conflate uptime with integrity. Defaults are
chosen to be safe and unobtrusive for interactive use; tighten
them for CI / unattended use.

```json
{
  "preferences": {
    "safety": {
      "atomicStaging":   true,
      "stagingTtlMs":    86400000,
      "lspPreSave":      "warn",
      "loopTrap": {
        "triggerCount":      3,
        "hardAbortCount":    6,
        "toolResultTailBytes": 1024,
        "maxHistory":        64,
        "enabled":           true
      }
    }
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `atomicStaging` | `boolean` | `true` | Route every file write through `AtomicStagingManager`. When `false`, the executor falls back to the legacy direct-write path (faster, but non-atomic). Set `false` only for benchmarks or trusted-LLM experimentation. |
| `stagingTtlMs` | `number` (ms) | `86400000` (24h) | Staged writes older than this are eligible for `garbageCollectAll`. Lower for low-disk environments; raise for very long-running sessions. |
| `lspPreSave` | `"off" \| "warn" \| "block"` | `"warn"` | Pillar 3 mode. See §5.2. |
| `loopTrap.triggerCount` | `number` | `3` | Consecutive equivalent turns that fire the `[Loop-Trap]` directive. |
| `loopTrap.hardAbortCount` | `number` | `6` | Consecutive equivalent turns that throw `LoopTrapAbortedError`. Must be ≥ `triggerCount`. |
| `loopTrap.toolResultTailBytes` | `number` (bytes) | `1024` | Length of the tool-result tail that is hashed. Min 64. |
| `loopTrap.maxHistory` | `number` | `64` | Cap on in-memory detector history. Must be ≥ `hardAbortCount`. |
| `loopTrap.enabled` | `boolean` | `true` | Master kill-switch. When `false`, the detector is constructed but never invoked. |

### Hardening profiles

| Profile | `atomicStaging` | `lspPreSave` | `loopTrap.triggerCount` | `loopTrap.hardAbortCount` |
|---|---|---|---|---|
| **Interactive dev** (default) | `true` | `"warn"` | `3` | `6` |
| **CI / unattended** | `true` | `"block"` | `2` | `4` |
| **Trusted fine-tune** | `false` | `"off"` | `5` | `10` |
| **Benchmarking** | `false` | `"off"` | `false` (kill-switch) | n/a |

---

## 8. Operational Runbooks

### 8.1 "The agent is stuck in a loop"

**Symptom:** session emits a `[Loop-Trap]` directive, the model
keeps repeating the same tool call.

**Diagnosis:**
```bash
tail -100 ~/.fixocli/telemetry.jsonl | jq 'select(.event == "loopTrap")'
```

**Response:**
1. Read the directive; it tells you the LLM *why* the loop is
   happening. Common causes:
   - The test command is failing consistently — fix the test.
   - The patch is being reverted by a pre-commit hook — fix
     the hook.
   - The agent is confused about file paths — clarify the task.
2. If the trap fires 3+ times in a session, the conversation
   history is also suspect. Consider `/fixo compact` to force
   a manual compaction.
3. To turn the detector off for a single session (debugging
   only), set `loopTrap.enabled` to `false` in
   `~/.fixocli/config.json`.

### 8.2 "LSP gate blocked my write"

**Symptom:** `write_file` returns
`Error: Pre-commit hook rejected: LSP pre-save blocked: N
error(s) in <path> — <line>:<col> <message>; ...`

**Diagnosis:**
1. Read the first 3 error messages in the error string — they
   are the gate's best guess at the root cause.
2. Open the file in your editor; the LSP (if installed) will
   underline the offending line.
3. Common causes:
   - Missing import — add it.
   - Type mismatch — fix the annotation.
   - Reference to an undeclared identifier — typo in the name.
4. The original file is **preserved**; re-run the agent's
   suggested fix and try again.
5. If the gate is over-firing (a known-good write is being
   rejected), lower the mode from `block` to `warn`:
   ```json
   { "preferences": { "safety": { "lspPreSave": "warn" } } }
   ```

### 8.3 "A write silently rolled back"

**Symptom:** the agent said it wrote a file, but the file is
unchanged.

**Diagnosis:**
1. Check the tool result string for `PreCommitHookRejectedError`
   or `StagingPathEscapeError`.
2. For `PreCommitHookRejectedError`, the `cause` field is the
   underlying error (`LspPreSaveBlockedError`, or a future
   pre-commit hook).
3. For `StagingPathEscapeError`, the target path escapes the
   workspace root — this is a caller bug.

**Response:**
- LSP gate: see §8.2.
- Path escape: the agent's tool call was bad. Reject and
  re-prompt.
- Future hook: read `cause.message` and remediate the
  underlying validator.

### 8.4 "Staging directory is filling my disk"

**Symptom:** `du -sh ~/.fixo/staging` shows > 100 MB.

**Diagnosis:**
```bash
ls -la ~/.fixo/staging/
```

**Response:**
1. Auto-GC runs at the start of every `runStreaming` cycle.
   If the directory is large *during* a session, an LLM is
   staging writes but failing to commit them. Inspect the
   session log for `PreCommitHookRejectedError`.
2. Manual sweep:
   ```bash
   rm -rf ~/.fixo/staging/*   # safe; staging is ephemeral
   ```
3. Lower `stagingTtlMs` to expire entries sooner:
   ```json
   { "preferences": { "safety": { "stagingTtlMs": 3600000 } } }
   ```

### 8.5 "A direct-provider API key was rejected"

**Symptom:** the agent's direct call returns `401 Unauthorized`
or `403 Forbidden`.

**Diagnosis:**
1. Confirm the key is configured:
   ```bash
   fixo providers list
   ```
2. Re-add the key if needed:
   ```bash
   fixo providers add openai sk-proj-...
   ```
3. The vault is auto-hydrated on the next `getDirectConfig`
   call, so the new key is visible immediately.

**Security note:** never paste a real key into a Slack
screenshot, a GitHub issue, or a tool result. `scrubForLlm`
will redact common shapes, but a low-entropy prefix is not
guaranteed to match.

### 8.6 "I need to fully reset the safety layer"

**Symptom:** the safety configuration is corrupted, or a
third-party plugin is interfering with the vault / staging
managers.

**Response:**
```bash
# Drop the staging directory (ephemeral)
rm -rf ~/.fixo/staging

# Drop the cached vault singleton (next call re-hydrates)
fixo providers reset-vault

# Reset to safe production defaults
fixo config reset --section safety
```

---

## 9. Extending the Safety Layer

### 9.1 Adding a new write tool

To get Pillar 2 (atomic staging) and Pillar 3 (LSP gate) for
free, route the write through `applyAtomicWrite`:

```ts
function executeMyNewTool(target: string, content: string, cwd: string, options: ToolExecutionOptions): Promise<string> {
  return applyAtomicWrite(cwd, target, content, options.safety, options.session)
    .then(() => `Wrote ${target}`);
}
```

The safety config, the staging manager, the LSP gate, and the
rollback logic are all inherited.

### 9.2 Adding a new direct provider

1. Add the entry to `PROVIDER_REGISTRY` in
   `src/agent/providers-manager.ts`.
2. Users add the key via `fixo providers add <name> <key>` —
   `add()` automatically ingests into the vault.
3. Add the resolution rule in `AgentClient.resolveDirectConfig`
   so the new provider is selected for the appropriate model
   prefix.
4. Add credential patterns to `SCRUB_PATTERNS` in
   `src/runtime/redaction.ts` if the provider uses a
   non-standard key shape.

### 9.3 Adding a new pre-commit hook

`AtomicStagingManager` accepts a `preCommitHook` in its
options. The hook runs after `stage()` and before the
`renameSync` swap; if it throws, the staging manager catches
the throw, wraps it in `PreCommitHookRejectedError`, and rolls
back. Example:

```ts
const mgr = new AtomicStagingManager(cwd, runId, {
  preCommitHook: async (entry) => {
    await runCustomLinter(entry.targetPath);
  },
});
```

### 9.4 Adding a new loop-trap layer

Subclass or wrap `LoopTrapDetector` and pass the new
composite into `record(snapshot)`. The detector is pure and
side-effect-free; the snapshot is opaque to the detector, so
adding a fourth layer (e.g. "network-call fingerprint") is a
matter of computing the additional hash and concatenating it
into the snapshot.

---

## 10. Testing & Verification

The safety layer is verified by **71 dedicated tests** (in
addition to the 163 resilience + integration tests):

| Test file | Count | Coverage |
|---|---:|---|
| `src/__tests__/loop-trap.test.ts` | 14 | All three fingerprint layers, threshold transitions, layer-mismatch non-trip, error shape, planner re-export. |
| `src/__tests__/staging.test.ts` | 15 | Stage/commit/discard/list, backup creation + cleanup, rollback on hook failure, GC per-run + global, performance < 50ms on 200 entries, runId validation. |
| `src/__tests__/lsp-pre-save.test.ts` | 14 | All three modes, provider timeout + rejection pass-through, end-to-end rollback preservation, header normalisation, observer safety. |
| `src/__tests__/credential-vault.test.ts` | 16 | `withApiKey` happy path + return value + async await + error propagation + missing-provider, `withCredential` exposure, `ingest` overwrite + empty-key rejection, safe accessors, concurrent isolation, singleton reset. |
| `src/__tests__/redaction.test.ts` | 12 | All major provider patterns, ANSI stripping, plain-text passthrough, `redactSecrets` backward-compat alias, `SCRUB_PATTERNS` export shape, `redactedEnv` env-var coverage. |
| **Total safety tests** | **71** | **All four pillars + redaction upgrade** |

Run the safety layer in isolation:

```bash
node --import tsx --test src/__tests__/loop-trap.test.ts \
                       src/__tests__/staging.test.ts \
                       src/__tests__/lsp-pre-save.test.ts \
                       src/__tests__/credential-vault.test.ts \
                       src/__tests__/redaction.test.ts
```

Run the full suite (234 tests):

```bash
node --import tsx --test src/__tests__/*.test.ts
```

---

## 11. Versioning & Compatibility

- **Public API surface** — the executor tool definitions, the
  agent-client method signatures, and the `FreeLLMConfig`
  schema are **unchanged** by the safety layer. All 163
  pre-existing tests pass unmodified.
- **Vault** — `ProviderKeyVault` is **additive**. The legacy
  `ProvidersManager.getDirectConfig(name)` continues to work
  (it now sources from the vault internally) and is marked
  `@deprecated` for new callers.
- **Redaction** — `redactSecrets` is preserved as a
  `@deprecated` alias of `scrubForLlm`. Existing callers
  automatically inherit the expanded pattern catalogue.
- **Loop-trap** — `LoopTrapDetector` is **additive** and
  **opt-in** via `preferences.safety.loopTrap.enabled`. The
  default is `true` for safety but a user can disable it
  without recompiling.

---

*Last updated with the Phase 2 safety refactor — 234/234 tests
green, build clean, ready for production.*

---

## 12. Phase 1–3 Tool Surface (Frontier-Tool Capability Layer)

Phases 1–3 extended the FixO CLI tool surface to match the
execution capabilities of frontier coding agents. Every new
tool runs **through the same four safety pillars**; none of
them introduces a bypass path. The catalogue below names each
new tool, the phase that delivered it, and the pillar(s) that
gate it.

### Phase 1 — Surgical Core

| Tool | What it does | Pillar gates |
| :--- | :--- | :--- |
| `str_replace` | Line-level surgical edit (`find` → `replace`) with uniqueness check. Hooks into `applySurgicalReplace` in `runtime/staging.ts`. | Pillar 2 (atomic staging) + Pillar 3 (LSP pre-save) + workspace guard |
| `glob_files` | Pattern-based file finder. | Workspace guard (paths stay inside `cwd`) |
| Generic `ToolSpecification` refactor | All tool args are now strongly typed. No `any` in the executor dispatch. | Type-level invariant — eliminates an entire class of injection paths |

### Phase 2 — Context & Continuity

| Tool / capability | What it does | Pillar gates |
| :--- | :--- | :--- |
| Resilient search chain (`BraveSearchProvider` → `TavilySearchProvider` → DuckDuckGo) | Multi-provider web search with per-provider quality metrics. | Credential vault (API keys never leave `withCredential`) |
| `.fixo/FIXO.md` loader | Project-specific instructions auto-loaded on every session. | Workspace guard (path is `cwd`-anchored) |
| `todo_write` / `todo_read` | Mutable task checklist tracking. | Pillar 2 (staging) + default-ask permission |
| `--resume` flag | Persistent session reconstitution from `.fixo/runs/<id>/`. | Workspace guard + session integrity checks |

### Phase 3 — Asynchronous Integrations

| Tool / capability | What it does | Pillar gates |
| :--- | :--- | :--- |
| `run_command_async` / `poll_command_status` / `kill_command` | Non-blocking shell execution with ring-buffered I/O caps. | Pillar 1 (command-parser AST validation) + granular permissions |
| `spawn_subagent` | Context-isolated sub-orchestrator loops. | Inherits parent's policy, vault, and workspace guard |
| `/mcp` console (list / add / restart) | Interactive MCP server management. | Config-only — does not touch the workspace |
| `PreToolUse` / `PostToolUse` hooks | Synchronised local-script execution hooks. | Hook scripts run in a constrained subprocess and cannot escape `cwd` |
| Granular permission rules (`Tool(arg-glob)`) | Pattern-matched first-match-wins permission engine. | Default-ask for any new Phase 1–3 tool with no matching rule |
| Worktree annotations (`[worktree:create branch=x]`) | Safe parallel-branch experiments. | Git invoked shell-free via `execFileSync` — no shell expansion |

### Phase 4 — Predictive Gates & Permission Wiring

| Change | What it does | Pillar gates |
| :--- | :--- | :--- |
| Predictive context-budget gate (`agent/predictive-gate.ts`) | Before `read_file` reads a file, projects token cost against current conversation pressure and defers if `> 85%` of the model window. Returns a `[Context-Budget Guard]` directive identical in shape to the byte-gate's. | Layered on top of the existing byte gate; never reads bytes when deferred |
| Permission engine pipe-through | All 6 legacy `decidePolicy` callsites (4 in `tool-executor.ts`, 1 in `worker-agent.ts`, 1 in `ui/prompt.ts`) now route through `checkPermission`. Rule matches fire first; legacy policy remains as the third tier inside `permissions.ts`. | Pillar 1 + Pillar 4 — no permission decision is now made without consulting `.fixo/permissions.json` first |

### Zero-Regression Assertion

Every Phase 1–3 tool — and every Phase 4 wire-through — routes
through the same four pillars:

1. **Command Safety** (`command-parser.ts` AST validation)
2. **Atomic Staging** (`AtomicStagingManager`)
3. **LSP Pre-Save** (`LspPreSaveGate.gate()`)
4. **Sealed Vault** (`getProviderKeyVault().withCredential`)

No new tool bypasses a pillar. No new tool reads the file
system without `WorkspaceGuard.resolve()`. The granular
permission engine added in Phase 3 *adds* a fifth checkpoint
(rule matching) without removing any of the four pillars.

Test coverage after Phase 4: **500 / 500 passing** (485
baseline + 12 predictive-gate + 3 permission-wiring), `tsc
--noEmit` clean, no `any` introduced in modified pathways.

## 13. Agent-Loop Resilience Additions

The five subsections below cover work that extends the four
pillars without changing their contract. Each addition is
optional from the safety standpoint (the pillars still pass
without it) but closes a class of agent-loop failure modes the
pillars alone do not catch — model drift, forgotten background
work, and mid-run instruction churn.

### 13.1 Edit-semantics steering (`tool-executor.ts`, `single-agent.ts`)

The `write_file` and `str_replace` tool descriptions now state
explicitly that `str_replace` is the default for in-place edits
and that `write_file` is reserved for new files or full
rewrites. The system prompt's `## Editing Discipline` block
encodes the same three-tier rule (str_replace single-region /
apply_patch multi-region / write_file new-or-rewrite). This
steers the LLM toward surgical edits — which already route
through Pillar 2 (AtomicStagingManager) and Pillar 3
(LspPreSaveGate) — without changing either pillar's contract.
Regression-guarded by `__tests__/tool-descriptions.test.ts`.

### 13.2 Multi-modal content pipe (`shared/types.ts`, `shared/content.ts`, `ui/image-attach.ts`)

`ChatMessage.content` is widened from `string | null` to
`string | ChatContentBlock[] | null`. Each block is a
discriminated union (`text` | `image`) so vision-capable
providers can see images alongside text without any per-call
type juggling. The `/image` slash command resolves paths
through `WorkspaceGuard.resolve()`, sniffs the MIME type from
the byte prefix (PNG / JPEG / WebP / GIF magic numbers, no
external library), and caps payloads at **5 MiB pre-base64**.
The flatten helper renders image blocks as `[image:mime]` so
base64 never leaks to logs or token counters. Token estimator
charges `IMAGE_TOKEN_COST = 1500` per image block. All paths
remain inside `WorkspaceGuard`; no pillar bypass is introduced.
Regression-guarded by `__tests__/multimodal.test.ts`.

### 13.3 Background-job awareness (`agent/background-awareness.ts`)

`BackgroundAwareness` injects a compact `[Background Jobs]`
directive at the head of every `chat()` call inside the agent
loop. Newly-finished jobs are announced exactly once (with exit
code and up to 200 chars of stderr tail for failures);
still-running jobs are listed each turn as a reminder so the
model is nudged to call `poll_command_status`. Total directive
is hard-capped at 1500 chars. Purely read-side — never
spawns, polls, or kills jobs (that responsibility stays in
`BackgroundJobRegistry`, which is itself gated by
`command-parser.ts`). Wired through the same
`injectSafetyDirective` slot already used by the semantic
loop-trap warning. Regression-guarded by
`__tests__/background-awareness.test.ts`.

### 13.4 FIXO.md per-turn re-injection (`context/fixo-md-watcher.ts`)

`FixoMdWatcher` captures a `{ path, source, mtimeMs, bytes }`
fingerprint of the active FIXO.md at agent-loop start, then
re-stats before each `chat()` call. When the file is created,
updated, or deleted mid-run, the delta is surfaced as a
`[Project Instructions]` directive through the same injection
slot. No `fs.watch`, no subprocess — one `fs.statSync` per
turn. The full content is read via the existing
`loadProjectInstructions()` helper, which already enforces a
1 MiB cap and the documented lookup-chain order. Regression-
guarded by `__tests__/fixo-md-watcher.test.ts`.

### 13.5 Predictive-gate soak coverage

Four integration-soak tests added on top of the existing
predictive-gate unit suite: (1) the `predictive_gate_fired`
TaskSession event records `path`, `projectedTokens`,
`projectedTotal`, and `hardCap`; (2) deferred reads still set
`event.affectedPath` to the resolved absolute path so the agent
loop can track them; (3) a zero-byte file never trips the gate
even at moderate conversation pressure; (4) sequential reads
across a 30–95% conversation-pressure sweep flip from allow to
defer monotonically and at a deterministic point (≥80%
pressure for a ~1.4k-token file at the default 85% budget pct).

### Zero-Regression Assertion (Section 13 extension)

None of the additions above introduces a new tool, new
filesystem path outside `WorkspaceGuard`, or new credential-
access route. Each one is observation-only or routes through
an existing pillar. The agent-loop directives are injected via
the same `injectSafetyDirective` slot used since Phase 2 for
the semantic loop-trap, so the precedent for "directive at the
head of the system prompt" already had safety review.

Test coverage after Section 13 work: **527 / 527 passing**
(523 baseline + 4 soak), `tsc --noEmit` clean, no `any`
introduced in any modified pathway.

