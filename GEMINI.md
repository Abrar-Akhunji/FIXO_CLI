## Graphify — AI Agent Rules

This project has a knowledge graph at `graphify-out/` (1691 nodes, 3963 edges, 109 communities).

### Core Rules for ALL AI Agents

- **Before answering any codebase question**, run:
  ```
  graphify query "<question>"
  ```
  Use the returned subgraph context to answer. Only read raw files if the graph context is insufficient.
- **After modifying any code**, run:
  ```
  graphify update .
  ```
  This is AST-only — no API cost, runs instantly.
- Use `graphify path "<A>" "<B>"` to trace relationships between two components.
- Use `graphify explain "<Concept>"` for focused deep-dives on a specific concept.
- **DO NOT** scan the entire codebase or load full files unless the graph context is insufficient.
- Prefer relationships, dependencies, and paths from the graph. Cite source files mentioned in graph output.
- If `graphify-out/wiki/index.md` exists, use it for broad navigation instead of raw source browsing.
- Read `graphify-out/GRAPH_REPORT.md` only for broad architecture review or when query/path/explain do not surface enough context.
