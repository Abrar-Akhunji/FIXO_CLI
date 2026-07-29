# FIXO CLI — Stabilization & Market-Readiness Plan

> Status: DRAFT for review. No implementation begins until this document is reviewed and approved.
> Verified against local worktree (uncommitted changes present; ahead of public `main`).
> Verification date: 2026-07-19.

## 1. Executive summary & locked decisions

FIXO CLI is structurally strong (~50k LOC TypeScript, 72 test files, clean conceptual
separation across providers / streaming / MCP / tool-executor / Git / staging / LSP /
sessions / DAG orchestration) but functionally unreliable. The failures are
**integration-wiring and logic bugs** — a wrong variable checked, a missing guard, a
safety layer never invoked from its call site — not memory-safety or performance
problems.

### Locked decision: no rewrite

**No Rust rewrite, no other-language rewrite, now.** Every defect found is a logic/wiring
bug that would be faithfully reproduced in any target language, at the cost of months of
work and the loss of the existing architecture and 72-file test suite. Revisit Rust only
if a specific, *measured* requirement appears later (sub-50ms cold start; OS-level
sandboxing Node genuinely cannot provide) — and even then only for isolable components
(PTY/TUI, sandbox, filesystem core) behind a JSON event protocol, never as a
module-by-module port.

### Locked decision: no competitor code

**No code copied from `ultraworkers/claw-code` (MIT, self-described "agent-managed museum
exhibit") or `xai-org/grok-build` (Apache-2.0, vendors third-party code, no external
contributions).** Their *architectural separation* (TUI / agent runtime / tools /
workspace / sandbox as distinct layers; headless mode; ACP editor integration) may be
studied as inspiration and reimplemented clean-room in FIXO's own idiom, with attribution
in comments/docs where a design is clearly derived from a specific published pattern.

### Locked decision: correctness before features

Nothing in Phase 3+ (honesty/first-run) or new features may begin before every Phase 1
(P0) and Phase 2 (P1) item has a passing regression test.

## 2. Defect ledger

Status legend: **CONFIRMED** = re-traced against current source; **FIXED-ALREADY** =
prior-audit claim already resolved in this worktree; **NOT-REPRODUCED** = claimed but not
found / already correct, needs a guard test only; **UNVERIFIED** = reported but not yet
re-traced to a live call path.

| ID | File:Line | Status | Root cause | Fix | Test | Phase |
|----|-----------|--------|-----------|-----|------|-------|
| A | `src/agent/tool-executor.ts:1772` | CONFIRMED | `const status = result.status ?? 0` turns a timeout/signal kill (`status: null`) into exit 0; `result.error` (spawn failure) never checked. Success string returned for a command that never finished. | Check `result.error`; treat `status === null` as distinct failure (`killedByTimeout`/`killedBySignal`); return structured `{ok, exitCode, signal?}` and propagate real code. | New: timeout kill → failure; spawn-fail → failure; exit 1 → failure. | 1 |
| B | `src/agent/tool-executor.ts:307` | CONFIRMED | `classifyExecutionRole` returns `READ_ONLY` on any read-only keyword (`review`, `audit`, `analyze`, `find bugs`) with **no** mutation-verb override. "review this module and fix the bugs" strips all write tools. | Mutation verb anywhere (`fix/implement/refactor/add/change/write/apply/create`) wins over read-only keyword — mirror `evaluateInputIntent` precedence in `single-agent.ts:117`. | `role-mask.test.ts`: "review X and fix bugs" + 4-5 paraphrases → `BUILD`. | 1 |
| C | `src/config.ts:444` | FIXED-ALREADY | `getStateDir()` already implements `FIXO_HOME` → XDG → platform fallback; `TaskSession:72` routes through `getWorkspaceStateDir()`. Prior `EPERM` was env (no `FIXO_HOME` set in sandbox), not a product gap. | No product fix. Thread `FIXO_HOME` through the test harness so `npm test` never writes real home. | Extend existing (untracked) `state-dir.test.ts`; set `FIXO_HOME` in a global test setup. | 0 |
| D | `src/runtime/background-jobs.ts:193` | NOT-REPRODUCED | `register()` already calls `isCommandSafe` before spawn. Prior claim that `run_command_async` skips the safety gate is stale. | No fix. Add parity coverage to prevent regression. | Same unsafe command through `run_command` and `run_command_async` → both blocked. | 2 |
| E | `src/agent/agent-pool.ts:119` | CONFIRMED | `this.worker = new WorkerAgent()` — one shared instance serves all concurrent subtasks, so per-instance `allowAll`/abort state leaks across peers. | Instantiate a `WorkerAgent` per subtask (or scope allowAll/abort per-run). | Two concurrent workers: one "allow all" must not affect the other. | 2 |
| F | `src/agent/agent-client.ts:1650` | CONFIRMED | Each `role: "tool"` message is pushed as its own `role: "user"` turn. Two tool calls in one turn → consecutive user messages; Anthropic Messages API requires the parallel `tool_result` blocks merged into a single user message. | Merge consecutive tool results into one `user` message with multiple `tool_result` blocks. | Fixture: assistant turn with 2 tool_calls → 2 tool results → assert single merged user message. | 1 |
| G | `src/agent/task-router.ts` (`writeLastRunSummary`) | CONFIRMED | On every complex-task run, appends `.fixo/` to the user's `.gitignore` (creating it if absent) — a workspace mutation the user never requested. (This is the 3.3 "not reproduced on main" claim; it IS present in this worktree.) | Make opt-in or remove; never silently edit user's `.gitignore`. If `.fixo/` must be ignored, log it explicitly or document it. | Run complex path in a temp repo with no `.gitignore`; assert none is created without consent. | 1 |
| H | `src/lsp/lsp-pre-save.ts` | UNVERIFIED | Prior audit: gate validates the on-disk (old) file, not staged new content. Header comment claims new content IS queried after staging — re-trace before scheduling. | If confirmed: point gate at post-edit staged content. | Change syntactically broken only in new content → gate must block. | 1 |
| I | `README.md:99,101,164,335,432` | CONFIRMED (docs) | README/tool-table advertise `spawn_subagent`, worktree annotations, `fixo --diagnose`, `/fixo gc`, `fixo providers list`. Reachability to a live call path not yet confirmed. | Per item: confirm reachable + add smoke test, OR relabel as roadmap/remove so docs match shipped surface. | Smoke test per surface that IS reachable. | 3 |
| J | `src/agent/tool-executor.ts:1116,1980` vs `1481,1656` | UNVERIFIED | Prior audit: `delete_file` may bypass the `.env`/sensitive-path blocklist that `write_file`/`str_replace` apply. Blocklist constants exist at 1481/1656; confirm `delete_file` path runs them. | If confirmed: route `delete_file` through the same blocklist. | `delete_file .env` / key file → blocked. | 2 |

Additional structural finding (not a defect, but market-readiness relevant): the four
largest files (`tool-executor.ts` ~2.7k, `agent-client.ts` ~1.65k, `prompt.ts` ~1.75k,
`single-agent.ts` ~1.5k) concentrate too much responsibility — Phase 4.

## 3. Phase 0 — Re-audit & hermetic foundation (~2-3 days)

Objective: make the whole suite runnable in CI/sandbox with zero real-home writes, and
close out the stale claims.

- [ ] Run full suite against current worktree; classify each failure as real-assertion vs
      environment/teardown. (Known: files pass assertions but exit 1 — root-cause the
      open-handle/teardown issue.)
- [ ] Add a global test setup that sets `FIXO_HOME` to a temp dir; assert no writes land
      in the real home. (Product code already supports the override — this is test-only.)
- [ ] Verify defect D (async safety) and mark closed with a parity test scheduled in P2.
- [ ] Re-trace defects H (LSP gate content source) and J (`delete_file` blocklist) to a
      live call path; move each to CONFIRMED or NOT-REPRODUCED.
- [ ] Root-cause the full-suite hang (the ~10-min zero-output run observed).
- **Exit criteria:** `npm test` is 100% hermetic (verifiable with `$HOME` pointed at a
  locked-down dir) and the hang is root-caused.

## 4. Phase 1 — P0 correctness (~1-2 weeks)

Objective: the agent does what was asked and tells the truth about the result.

- [ ] **A** — fix `executeRunCommand` exit/error handling; introduce structured result.
- [ ] Make the UI `✔`/`✗` indicator key off the structured result field, not a string
      `"Error:"` prefix.
- [ ] **B** — mutation-verb precedence in `classifyExecutionRole`; add "review AND fix"
      regression cases.
- [ ] **G** — stop silent `.gitignore` mutation.
- [ ] **F** — merge parallel Anthropic `tool_result` blocks into one user message.
- [ ] **H** — (if confirmed in Phase 0) point LSP pre-save gate at new content.
- [ ] Guard SSE `choice.delta` access so a malformed/partial chunk can't crash a live
      stream; fixture-driven test with a truncated payload.
- **Exit criteria:** a `tests/e2e/` scenario suite exercises
  setup → stream → tool call → simulated timeout/kill → rollback → resume for at least one
  provider path, and passes.

## 5. Phase 2 — P1 safety actually engaged (~1 week)

Objective: prove safety layers fire from every call site, not just the main loop.

- [ ] Trace every call site of the safety/session/signal context in `single-agent.ts`
      AND `worker-agent.ts`; prove PLAN-mode enforcement, staging, and loop-trap run in
      both. Add a worker-agent PLAN-mode block test.
- [ ] **J** — `delete_file` sensitive-path blocklist parity (if confirmed) + test.
- [ ] **D** — `run_command` vs `run_command_async` `isCommandSafe` parity test.
- [ ] **E** — per-subtask `WorkerAgent` instance; concurrent-worker isolation test.
- **Exit criteria:** a matrix test (mode × tool × entry point) covering single-agent and
  worker-agent passes identically.

## 6. Phase 3 — P2 honesty & first-run (~3-5 days)

Objective: shipped surface matches documented surface; zero-key onboarding is honest.

- [ ] **I** — for each documented CLI surface, confirm-and-smoke-test OR relabel/remove.
- [ ] Fix or honestly document the zero-key path (real free-tier default + live signup
      link, or explicit bring-your-own-key at setup). Ensure the setup wizard doesn't
      contradict the README's "FreeLLMAPI is opt-in" positioning.
- [ ] Regenerate `dist/`; reconcile `CHANGELOG.md` with actual releases (4 versions
      behind); fix the `postinstall` `pipx install graphifyy` typo / unwanted per-install
      side effect.
- **Exit criteria:** fresh clone → `npm install` → `fixo` with no key produces an honest,
  actionable message — never a silent failure or a task silently sent to an LLM.

## 7. Phase 4 — Structural debt (parallelizable; land last)

Objective: reduce regression surface. Refactor only — zero behavior change.

- [ ] Split `tool-executor.ts` into per-domain adapters (filesystem, shell, Git/worktree,
      MCP, search, todo) behind the same `executeTool()` dispatch contract.
- [ ] Split `agent-client.ts` into provider-protocol adapters only (no workflow logic).
- [ ] Extract the shared conversation/tool loop from `single-agent.ts` and share it with
      `worker-agent.ts` (do this *before or alongside* Phase 2, since it supports E).
- [ ] Audit `prompt.ts`/`render.ts` for workflow logic that belongs in the runtime;
      extract so UI consumes typed events only.
- **Exit criteria:** no `src/agent/` file exceeds ~800-1000 lines without documented
  reason; each new adapter has its own test file; a before/after parity snapshot of tool
  outputs shows zero behavior change.

## 8. Deterministic compatibility harness (build once)

Stand up before or alongside Phase 1:

- Local mock OpenAI- and Anthropic-compatible HTTP servers (fixtures, not live) replaying:
  normal streaming, mid-stream cut, malformed chunk, tool-call turn, timeout, 429/5xx,
  kill-signal-mid-command.
- Recorded fixture set across the 13 providers' request/response shape differences
  relevant to FIXO's parsing (this is the class of test that catches defect F before
  users do).
- Wire into CI as a required check; add Windows to the matrix once hermetic (depends on
  Phase 0).

## 9. What "market-ready" means — track these metrics

Add lightweight telemetry or a test-suite proxy for each:

- Task completion rate by command and by provider.
- Tool-call success/failure rate with a failure-reason taxonomy.
- Rollback correctness — cancelled/failed run leaves the workspace byte-identical
  (hash comparison, not "no crash").
- Time-to-first-token per provider.
- Task success verified by an *independent* check (build/tests), never the agent's own
  self-report — which is exactly what defect A currently corrupts.

## 10. What we explicitly did NOT do, and why

- **No Rust/other rewrite.** Defects are logic/wiring, not language-level; a rewrite
  reproduces them all and discards the working architecture + test suite.
- **No competitor code copied.** License/provenance risk; only clean-room pattern reuse.
- **No new features before P0/P1 land.** Honesty and correctness first; features built on
  a false-success foundation inherit the falsehood.

