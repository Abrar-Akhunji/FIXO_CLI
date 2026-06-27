# Graphify — Claude Code Agent Rules

This project has a Graphify knowledge graph at `graphify-out/`.

## Mandatory Rules

### Reading the Codebase
Before answering any question about the codebase, ALWAYS query the graph first:

```bash
graphify query "<your question>"
```

- Use the returned subgraph to answer. Do **not** scan raw files unless graph context is insufficient.
- Use `graphify path "<A>" "<B>"` to trace how two files/functions relate.
- Use `graphify explain "<Concept>"` for focused concept deep-dives.
- For broad architecture: read `graphify-out/GRAPH_REPORT.md`.

### After Every Code Change
After **every** file modification, run:

```bash
graphify update .
```

This keeps the graph fresh (AST-only, no API cost, instant).

### Rules
- DO NOT load full files unless absolutely necessary.
- DO NOT scan entire directories.
- Prefer graph relationships and paths over file browsing.
- Cite source files from graph output when responding.
