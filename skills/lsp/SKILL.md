---
name: lsp
description: Use codex-lsp-bridge for read-only semantic diagnostics, definitions, references, symbols, hover, and status checks.
---

# codex-lsp-bridge

Use the `codex-lsp-bridge` MCP tools as a semantic feedback layer for code work.

- Prefer `lsp_diagnostics` after editing supported source files.
- During code review, audit, or investigation workflows, call `lsp_diagnostics` for changed supported files or the smallest representative set before final findings.
- For large TypeScript workspaces, use file diagnostics `timeoutMs` when the default wait is too short. Do not pass `timeoutBudgetMs` for file diagnostics; it is directory-only.
- Avoid broad directory diagnostics by default. If a directory scan is needed, keep `maxFiles`, `timeoutBudgetMs`, and `concurrency` bounded and report `directory.truncated` or `directory.budgetTimedOut` when present.
- Treat `directory.sourceFileListCache` as a scan performance hint only. Diagnostic contents are still produced by LSP calls.
- Prefer file-position inputs for `lsp_definition`, `lsp_references`, and `lsp_hover` when the exact occurrence is known.
- For detached PR worktrees or temp review checkouts, pass the worktree path as `root` when the file path alone does not identify the intended workspace. The root must be a real workspace, such as a path with `.git`, `package.json`, or `tsconfig.json`.
- Use `lsp_status` before trusting results if language-server availability, Codex hook setup, or build freshness is unclear.
- Treat `status: "timed_out"` or `conclusion: "inconclusive"` differently from no diagnostics. Say the result is pending/unknown and not type-check passed instead of claiming the file is clean.
- Treat `conclusion: "diagnostics_clean"` as "no LSP diagnostics returned for this request", not as a full project type-check pass.
- If LSP is unavailable, ambiguous, or outside the workspace root, fall back to the narrowest repo-native verification command.
