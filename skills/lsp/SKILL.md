---
name: lsp
description: Use Codex LSP tools from codex-lsp-bridge for substantial code tasks that need semantic diagnostics, go-to-definition, references, symbols, or hover/type information. Trigger when work involves TypeScript, JavaScript, Python, Rust, or Go code and asks about type errors, semantic correctness, blast radius, refactors, imports, call sites, definitions, references, or symbol/type understanding. Do not use for tiny one-line edits, markdown-only work, config-only changes, or when no LSP server is available.
---

# LSP

Use the `codex-lsp-bridge` MCP tools as Codex's semantic feedback layer when
they are available.

## Core Workflow

1. Use text search first to locate candidate files and exact positions.
2. Identify the target file's workspace root before calling LSP.
3. Use LSP to resolve semantics once you have a file position or a file to diagnose.
4. Fall back to repo-native checks when LSP is unavailable, stale, ambiguous, or outside its contract.

## Tools

- `lsp_diagnostics`: Check file diagnostics after edits or when investigating type or semantic failures.
- `lsp_definition`: Resolve a symbol at a known file, line, and character; use symbol-only lookup only when ambiguity is low.
- `lsp_references`: Find references before renames, moves, signature changes, and import rewrites.
- `lsp_symbols`: Search workspace symbols by query when text search is too noisy.
- `lsp_hover`: Inspect type or hover information at a known file position.
- `lsp_status`: Check language-server availability and bridge configuration when LSP behavior is unclear.

## High-Leverage Plays

- After editing supported source files, run `lsp_diagnostics` on the touched files before broader verification.
- For refactors, use `rg` to locate the declaration or usage, then call `lsp_references` at the exact occurrence before editing.
- For unfamiliar code, use `lsp_definition` and `lsp_hover` to verify real types instead of inferring from names.
- Treat `lsp_status`'s context-derived `seedFile` as informational, not target selection. For every target outside the current task workspace, pass the nearest workspace `root` explicitly with `file` or `dir`. The bridge auto-detects an absolute outside target as a fallback, but explicit `root` is deterministic.
- For Codex skill code, use the skill folder containing `SKILL.md` as `root`. A shared `.codex\skills` parent with `package.json` also works.
- If a code folder has no recognized marker, use its nearest marked parent or add an empty `.lsp-root` sentinel inside that user-owned workspace. Never broaden `root` to `C:\` or the full user profile just to bypass containment.

## Runtime and Lifecycle Guardrails

- Use `lsp_status` before trusting results when language-server availability,
  Codex hook setup, or build freshness is unclear.
- Explicit MCP diagnostics remain available when automatic `PostToolUse`
  diagnostics are disabled. Do not assume the hook is active.
- The bridge runtime must use an approved native `node.exe` directly. Generated
  MCP, updater, and hook launch commands must not use a bare `node`, `node.cmd`,
  another command shim, or `node_repl.exe` for the bridge runtime. A configured
  language server may still use a supported `.cmd` or `.bat` launcher.
- Within one live MCP process, expect one manager per workspace root and one
  provider per language. Do not promise or design cross-connection reuse unless
  a separate scope decision authorizes it.
- Codex users do not select, attach to, or manage bridge or language-server
  processes. Treat `node_repl.exe` as separate Codex Code Mode infrastructure,
  not as bridge load.
- For process, lifecycle, or performance work, read
  [the process and lifecycle contract](../../docs/PROCESS-AND-LIFECYCLE.md).

## Boundaries

- LSP diagnostics are opened-file language-server diagnostics, not full project validation.
- Still run project checks such as `tsc --noEmit`, `pyright`, `ruff`, unit tests, or build commands when the task requires whole-project confidence.
- TypeScript and Pyright require their language-server binaries (`typescript-language-server`, `typescript`, `pyright`) to be installed and discoverable.
- Position-based tools use 1-based `line` and `character` values.
- Recognized roots include `.git`, `.lsp-root`, `AGENTS.md`, `CLAUDE.md`, `SKILL.md`, and common TypeScript, Python, Rust, Go, and Deno project manifests.
- Treat `status: "timed_out"`, `stale`, `unavailable`, `missing`, or `conclusion: "inconclusive"` as pending or unknown. Never report those states as a clean type-check result.
- Treat `conclusion: "diagnostics_clean"` as "no LSP diagnostics returned for this request", not as a full project type-check pass.
