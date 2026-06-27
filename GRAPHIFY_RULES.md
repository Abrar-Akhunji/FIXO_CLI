# Graphify — Knowledge Graph Rules for All AI Providers

> This file is the single source of truth for how AI agents should use the Graphify knowledge graph in this project.
> Rules here apply to **Claude Code**, **FIXO**, **Gemini CLI**, and any other AI coding tool.

---

## What Is Graphify?

Graphify converts this codebase into a queryable knowledge graph stored at `graphify-out/`.
The graph contains:

- **1691 nodes** — files, functions, classes, variables
- **3963 edges** — imports, calls, references, dependencies
- **109 communities** — logical clusters of related code

Instead of reading raw files, AI agents query this graph for dramatically reduced token usage and better architectural understanding.

---

## Universal Rules (All Providers)

### Rule 1: Query First, Read Files Last

Before answering any question about the codebase, run:

```bash
graphify query "<your question>"
```

Use the returned subgraph context to formulate your answer.
**Only read raw source files if the graph context is insufficient.**

### Rule 2: Update After Every Code Change

After **every** file modification (no exceptions), run:

```bash
graphify update .
```

- AST-only — no API cost, runs in seconds
- Keeps the graph accurate for future queries
- Required before commits (enforced by pre-commit hook)

### Rule 3: Use Specialized Commands

| Goal | Command |
|------|---------|
| Answer a question | `graphify query "<question>"` |
| Trace A → B relationship | `graphify path "<A>" "<B>"` |
| Deep-dive on a concept | `graphify explain "<Concept>"` |
| Full architecture overview | `cat graphify-out/GRAPH_REPORT.md` |
| Find a specific file | `graphify query "find <filename>"` |

### Rule 4: Cite Graph Sources

When responding based on graph output, cite the source files mentioned in the graph context (e.g., `src/providers/openai.ts#L42`).

---

## Provider-Specific Setup

### Claude Code

Claude reads `CLAUDE.md` automatically. Rules are defined there.

**Trigger graphify install for Claude:**
```bash
graphify install
```

### Gemini CLI / Gemini (Antigravity IDE)

Gemini reads `GEMINI.md` automatically. Rules are defined there.

**Trigger graphify install for Gemini:**
```bash
graphify install --platform gemini
```

### FIXO

FIXO reads `.fixo/GRAPHIFY_RULES.md`. Rules are defined there.

### Cursor

Add to your `cursor.rules` or `.cursorrules`:

```
You have access to a Graphify knowledge graph at graphify-out/graph.json.

For every codebase question:
1. First run: graphify query "<question>"
2. Use the returned context to answer.
3. Only read files if graph context is insufficient.

After every code change, run: graphify update .
```

**Trigger graphify install for Cursor:**
```bash
graphify cursor install
```

### GitHub Copilot CLI

```bash
graphify install --platform copilot
```

---

## Automatic Graph Updates

The graph is automatically updated in two ways:

### 1. Git Pre-Commit Hook
Located at `.git/hooks/pre-commit` (local only, not committed).
Runs `graphify update .` before every commit.

### 2. npm `postinstall` hook
Runs `graphify update .` after every `npm install`.
Can also be triggered manually:

```bash
npm run graphify:update
```

---

## Querying Examples

```bash
# Show how authentication works
graphify query "show auth flow"

# Find what handles provider routing
graphify query "how are LLM providers selected"

# Trace a function call chain
graphify path "src/index.ts" "src/providers/openai.ts"

# Explain a module
graphify explain "ProviderRegistry"

# Find unused exports
graphify query "which exports are not imported anywhere"
```

---

## Growing the Graph

The graph gets smarter as you add more context:

```bash
# Add an external resource (paper, blog, docs)
graphify add <url>

# Re-run full build (includes docs, PDFs, images)
# Run this inside your AI assistant:
/graphify .

# Fast incremental update (code only, no API)
graphify update .
```

Keep a `/raw` folder and drop any notes, specs, or docs in it — Graphify will connect them to the code graph.

---

## Reference

- Source: [github.com/safishamsi/graphify](https://github.com/safishamsi/graphify)
- Package: `pipx install graphifyy` (double-y is the official package)
- Graph location: `graphify-out/` (gitignored — local only)
