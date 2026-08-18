# codex-lsp-bridge-windows

Read-only LSP tools for Codex. This fork focuses on Windows reliability, root-aware diagnostics, and quiet PostToolUse semantic feedback for touched source files.

## Commands

```powershell
npm install
npm run type-check
npm test
npm run build
npm run verify:package
npm run smoke:install
npm run smoke:package
npm run ci:verify
```

Use `npm run ci:verify` before pushing changes that touch source, tests, package metadata, scripts, hooks, or install behavior. It runs type-check, coverage tests, build, package verification, install smoke, and package smoke.

GitHub CI runs `npm ci` and `npm run ci:verify` on Ubuntu, macOS, and Windows with Node 22 and 24.

## Architecture

- `src/index.ts` is the CLI/MCP entry point.
- `src/transport/mcp.ts` exposes the MCP tools.
- `src/core/json-rpc-lsp-client.ts` owns JSON-RPC framing, process startup, server request responses, and Windows command preparation.
- `src/core/lsp-semantic-provider.ts` coordinates LSP initialization, diagnostics, definitions, references, symbols, and hover.
- `src/core/diagnostics.ts` formats diagnostics and reports `status`, `timedOut`, `stale`, and `sourceRevision`.
- `src/core/doctor.ts` reports language-server availability, Codex installation state, build freshness, and recommendations.
- `src/adapters/language-config.ts` maps supported languages, extensions, seed files, install hints, and command resolution.
- `scripts/install-codex.mjs` installs Codex MCP config, PostToolUse hook config, and AGENTS.md instructions.
- `scripts/codex-lsp-post-tool-use.mjs` is the PostToolUse diagnostics hook.
- `tests/` mirrors the core behavior; add or update tests for behavior changes.

## Supported Languages

- TypeScript/JavaScript: primary support through `typescript-language-server` for `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, and `.cjs`.
- Python: experimental support through `pyright-langserver`.
- Rust: experimental support through `rust-analyzer`.
- Go: experimental support through `gopls`.

Keep TypeScript/JavaScript as the primary path unless the task explicitly expands another language.

## Project Constraints

- The bridge is read-only. Do not add rename, code-action, edit, or write-capable LSP behavior without explicit design work.
- Do not hide LSP failures behind permissive fallbacks. Missing, timed-out, stale, and unavailable diagnostics must stay visibly distinct from clean diagnostics.
- Preserve workspace-root boundaries. Code that resolves files, URIs, symlinks, or command paths must not allow reads outside the configured root.
- Prefer precise file/root inputs over broad scans. Directory diagnostics must remain bounded by `maxFiles`, concurrency, and timeout budgets.
- Keep installer changes idempotent. Existing Codex config, hooks, and AGENTS.md blocks should be updated in place, not duplicated.

## Windows Gotchas

- Use PowerShell for local shell work on this machine.
- npm language-server launchers on Windows are often `.cmd` shims. Keep command resolution compatible with local `node_modules/.bin`, `PATH`, and `PATHEXT`.
- `prepareSpawnCommand` should rewrite common npm shims to direct Node entrypoints when possible, and only fall back to a safe `cmd.exe` wrapper when needed.
- Be careful with path separators when tests simulate Windows shims on non-Windows runners.
- Git may warn that LF files will be replaced by CRLF locally; avoid formatting-only churn.

## Testing Guidance

- For command-resolution or URI changes, run the targeted tests first:

```powershell
npm run test:run -- tests/json-rpc-lsp-client.test.ts tests/adapters-and-uri.test.ts
```

- For diagnostics behavior, run:

```powershell
npm run test:run -- tests/diagnostics.test.ts tests/lsp-semantic-provider.test.ts tests/diagnostics-timeout.test.ts
```

- For installer, hook, package, or public contract changes, run:

```powershell
npm run ci:verify
```

Update `README.md`, `CONTRIBUTING.md`, or `docs/` when user-facing commands, install behavior, supported languages, or public tool output changes.

## Release And Public Repo Notes

- Public repo: `https://github.com/jbk1998/codex-lsp-bridge-windows`.
- Package metadata still uses the upstream package name `codex-lsp-bridge`; be deliberate before changing package identity.
- Dependabot previously flagged `vitest < 4.1.0`; current test stack is `vitest` and `@vitest/coverage-v8` `4.1.8`.
- The root `README.md` is the main user-facing explanation of what this fork does well. Keep it accurate when changing Windows command resolution, hook behavior, supported languages, or install flow.
