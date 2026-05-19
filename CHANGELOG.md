# Changelog

## 0.1.0

Initial MVP release.

- Read-only MCP tools for diagnostics, definitions, references, symbols, hover, and status.
- Workspace-root file boundary with realpath checks and explicit `root` support for detached worktrees.
- Diagnostics trust metadata: `status`, `timedOut`, `stale`, and `sourceRevision`.
- Open document lifecycle support with `didOpen`, `didChange`, `didClose`, and restart re-sync.
- Quiet PostToolUse diagnostics hook with clean timeout suppression and duplicate error dedupe.
- Bounded directory diagnostics with `maxFiles`, `timeoutBudgetMs`, `concurrency`, and directory metadata.
- TypeScript primary support, with Rust, Python, and Go adapters marked experimental.
- Codex installer/uninstaller, plugin metadata, hooks, skill, CI, package verification, and install smoke tests.
