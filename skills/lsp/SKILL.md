---
name: lsp
description: Use codex-lsp-bridge for read-only semantic diagnostics, definitions, references, symbols, hover, and status checks.
---

# codex-lsp-bridge

Use the `codex-lsp-bridge` MCP tools as a semantic feedback layer for code work.

- Prefer `lsp_diagnostics` after editing supported source files.
- During code review, audit, or investigation workflows, call `lsp_diagnostics` for changed supported files or the smallest representative set before final findings.
- Prefer file-position inputs for `lsp_definition`, `lsp_references`, and `lsp_hover` when the exact occurrence is known.
- Use `lsp_status` before trusting results if language-server availability, Codex hook setup, or build freshness is unclear.
- Treat `status: "timed_out"` differently from no diagnostics. Say the result is pending or stale instead of claiming the file is clean.
- If LSP is unavailable, ambiguous, or outside the workspace root, fall back to the narrowest repo-native verification command.
