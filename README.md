# codex-lsp-bridge

Read-only LSP tools for Codex CLI.

`codex-lsp-bridge` gives Codex semantic signals from your local language
servers — diagnostics, definitions, references, symbols, hover, and status —
without granting write access or escaping the workspace root.

It is meant to be a semantic safety layer for AI coding workflows:

- understand type and semantic diagnostics after edits
- navigate definitions and references without guessing from grep alone
- inspect hover/type information at known file positions
- keep review and refactor loops read-only by default

## Status

The MVP is intentionally narrow and ready for local always-on use.

- Read-only first
- TypeScript-focused in practice
- Rust, Python, and Go adapters are present but less exercised
- No automatic language server installation
- No rename/code-action support yet

## Requirements

- Node.js 20+
- Codex CLI with MCP support
- Local language server executable for the language you want to use

| Language | Support | Required command | Install hint |
| --- | --- | --- | --- |
| TypeScript / JavaScript | Primary | `typescript-language-server` | `npm install -g typescript-language-server typescript` |
| Rust | Experimental | `rust-analyzer` | `rustup component add rust-analyzer` |
| Python | Experimental | `pyright-langserver` | `npm install -g pyright` |
| Go | Experimental | `gopls` | `go install golang.org/x/tools/gopls@latest` |

For TypeScript projects, install a language server if needed:

```bash
npm install -g typescript-language-server typescript
```

`lsp_status` and `codex-lsp-bridge doctor --root .` report the detected
language-server command, support level, seed file, install hint, and actionable
recommendations for missing setup.

## Quick Start

Install a language server for your project. For TypeScript:

```bash
npm install -g typescript-language-server typescript
```

Install the Codex MCP server, hook, and instructions:

```bash
npx codex-lsp-bridge@latest install
```

Restart Codex. The `lsp_diagnostics`, `lsp_definition`, `lsp_references`,
`lsp_symbols`, `lsp_hover`, and `lsp_status` MCP tools are then available to
Codex.

For an auto-updating install that resolves the latest npm package whenever
Codex restarts:

```bash
npx codex-lsp-bridge@latest install --auto-update
```

## Install Options

From the private GitHub repository before npm publish:

```bash
npm exec --package=github:shjeon-96/codex-lsp-bridge -- codex-lsp-bridge install
```

Auto-updating setup from the private GitHub repository:

```bash
npm exec --package=github:shjeon-96/codex-lsp-bridge -- codex-lsp-bridge install --auto-update --package github:shjeon-96/codex-lsp-bridge#main
```

From a local checkout:

```bash
npm install
npm run build
npm exec -- codex-lsp-bridge install
```

From a globally installed package:

```bash
codex-lsp-bridge install
```

Preview the generated Codex config without writing files:

```bash
codex-lsp-bridge install --dry-run
```

The installer writes:

- `~/.codex/config.toml`: global MCP server registration
- `~/.codex/hooks.json`: `PostToolUse` hook for touched TS/TSX diagnostics
- `~/.codex/AGENTS.md`: managed workflow instructions that tell Codex to use
  LSP diagnostics during review, audit, and investigation workflows, not only
  after edits

Restart Codex after installing.

## Codex Plugin Package

This repository includes Codex plugin metadata for marketplace-style
distribution:

- `.codex-plugin/plugin.json`
- `.mcp.json`
- `hooks/hooks.json`
- `skills/lsp/SKILL.md`

When a marketplace entry is available, Codex CLI installs plugins with:

```bash
codex plugin add codex-lsp-bridge@<marketplace>
```

Until then, use the `npx codex-lsp-bridge@latest install` path above. It writes
the same MCP registration, hook, and workflow instructions directly into
`~/.codex`.

## Uninstall

Remove the MCP server registration and automatic diagnostics hook:

```bash
npx codex-lsp-bridge@latest uninstall
```

From the private GitHub repository before npm publish:

```bash
npm exec --package=github:shjeon-96/codex-lsp-bridge -- codex-lsp-bridge uninstall
```

For a local checkout or global install:

```bash
codex-lsp-bridge uninstall
```

Preview the removal first:

```bash
codex-lsp-bridge uninstall --dry-run
```

The uninstall command removes only the `codex-lsp-bridge` config block and hook
entry, plus the managed `codex-lsp-bridge` block in `~/.codex/AGENTS.md`. It
leaves unrelated Codex config and instructions intact.

## What Gets Installed

By default, the global MCP config points Codex at the built server:

```toml
[mcp_servers.codex-lsp-bridge]
command = "node"
args = [
  "/absolute/path/to/codex-lsp-bridge/dist/index.js",
  "mcp"
]
```

With `--auto-update`, the global MCP config points Codex at npm instead:

```toml
[mcp_servers.codex-lsp-bridge]
command = "npm"
args = [
  "exec",
  "--yes",
  "--package=codex-lsp-bridge@latest",
  "--",
  "codex-lsp-bridge",
  "mcp"
]
```

That mode lets other users receive package updates after restarting Codex,
without manually reinstalling the MCP config. It depends on npm package
resolution, so use the default local install mode for active local development.

Without `--root`, the server uses the Codex process working directory as the
workspace root. That makes one global registration usable from any repository.
MCP tool calls do not infer a new workspace root from `file` or `dir` paths.
For detached review worktrees such as `/tmp/pr-1558-review`, pass `root`
explicitly in the tool call. Explicit `root` values must point at a
recognizable workspace containing `.git`, `package.json`, or `tsconfig.json`.

The hook runs after edit tools and checks touched TS/TSX files:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit|apply_patch|functions.apply_patch",
        "hooks": [
          {
            "type": "command",
            "command": "node '/absolute/path/to/codex-lsp-bridge/scripts/codex-lsp-post-tool-use.mjs'",
            "id": "codex-lsp-bridge:post-tool-diagnostics"
          }
        ]
      }
    ]
  }
}
```

The hook is intentionally post-tool, not pre-tool. Diagnostics are useful after
a file changes, not before. Read-only review sessions will not trigger the hook
unless Codex edits a file or explicitly calls the MCP diagnostics tool.

Hook output is intentionally quiet:

- clean files print one short line
- `timed_out` with no diagnostics is silent by default
- `CODEX_LSP_HOOK_VERBOSE_PENDING=1` prints `LSP diagnostics pending`
- warning/hint-only diagnostics print a compact count
- repeated identical error output is deduplicated
- `CODEX_LSP_HOOK_MAX_FILES` limits touched-file fanout, default `5`

The installer also adds a managed `codex-lsp-bridge` section to
`~/.codex/AGENTS.md`. That section is what makes review, audit, and
investigation workflows ask for semantic diagnostics even when no file edit has
happened yet.

## CLI Usage

Run against the current repository:

```bash
codex-lsp-bridge doctor --root .
codex-lsp-bridge diagnostics --file src/file.ts --root .
codex-lsp-bridge diagnostics --dir src --severity error --max-files 50 --timeout-budget-ms 15000 --concurrency 2 --root .
codex-lsp-bridge symbols Editor --root .
codex-lsp-bridge definition Editor --root .
codex-lsp-bridge references Editor --root .
codex-lsp-bridge hover Editor --root .
```

Prefer file-position queries when you know the exact occurrence:

```bash
codex-lsp-bridge definition --file src/store/editor.ts --line 24 --character 14 --root .
codex-lsp-bridge references --file src/store/editor.ts --line 24 --character 14 --root .
codex-lsp-bridge hover --file src/store/editor.ts --line 24 --character 14 --root .
```

Choose another language:

```bash
codex-lsp-bridge diagnostics --file src/main.rs --language rust --root .
codex-lsp-bridge diagnostics --file app.py --language python --root .
codex-lsp-bridge diagnostics --file main.go --root .
```

File-position commands and file diagnostics auto-detect the language from the
file extension. Symbol-only commands use TypeScript by default unless
`--language` is provided.

Diagnostics include trust metadata:

```json
{
  "status": "ok",
  "timedOut": false,
  "stale": false,
  "sourceRevision": 1
}
```

`status: "timed_out"` means the bridge did not receive fresh
`textDocument/publishDiagnostics` before the timeout. Treat that differently
from "no diagnostics".

## MCP Tools

The MCP server implements:

- `initialize`
- `tools/list`
- `tools/call`

Available tools:

| Tool | Purpose |
| --- | --- |
| `lsp_diagnostics` | Return compressed diagnostics with trust metadata |
| `lsp_definition` | Find definition by symbol or file position; prefer position |
| `lsp_references` | Find references by symbol or file position; prefer position |
| `lsp_symbols` | Search workspace symbols; accepts optional `root` |
| `lsp_hover` | Return hover/type information |
| `lsp_status` | Return language server, Codex install, and build status |

Example `tools/call` request:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "lsp_symbols",
    "arguments": {
      "query": "Editor"
    }
  }
}
```

Status request:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "lsp_status",
    "arguments": {}
  }
}
```

## Configuration

Optional JSON config is read from `~/.codex/lsp-client.json` and then
`<workspace>/.codex/lsp-client.json`; workspace config wins.

```json
{
  "defaultLanguage": "typescript",
  "diagnosticsTimeoutMs": 5000,
  "hook": {
    "maxFiles": 5,
    "verbosePending": false
  },
  "languageServers": {
    "typescript": {
      "command": "typescript-language-server",
      "args": ["--stdio"]
    }
  }
}
```

For TypeScript, a workspace-local
`node_modules/.bin/typescript-language-server` is preferred when present, then
the configured command or PATH command is used.

## Plugin Layout

The package includes plugin-oriented metadata:

- `.codex-plugin/plugin.json`
- `.mcp.json`
- `hooks/hooks.json`
- `skills/lsp/SKILL.md`

These files mirror the one-command installer and make the package easier to
adapt to Codex plugin distribution flows.

See [docs/MARKETPLACE.md](./docs/MARKETPLACE.md) for marketplace packaging
notes.

## Suggested Codex Behavior

For best results, use these rules in global or project instructions:

```md
When codex-lsp-bridge MCP tools are available, use them proactively for
TypeScript/TSX semantic feedback. After editing TS/TSX files, call
`lsp_diagnostics` for touched files before broader verification. Before
renames, moves, signature changes, or multi-file semantic refactors, call
`lsp_definition` and `lsp_references`. Prefer file-position inputs over
symbol-only inputs when the occurrence is known. If LSP is unavailable, stale,
timed out, or ambiguous, say so and fall back to the narrowest repo-native
verification command.
```

## Smoke Test

After building this repository:

```bash
codex-lsp-bridge symbols CommandService --root .
codex-lsp-bridge references CommandService --root .
codex-lsp-bridge diagnostics --file src/core/command-service.ts --root .
```

MCP stdio smoke test:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"lsp_symbols","arguments":{"query":"CommandService"}}}' \
  | node dist/index.js mcp
```

## Design Notes

- The bridge is read-only.
- File access is constrained to the workspace root. The bridge resolves both
  the workspace root and requested files with `fs.realpath` before reading, so
  symlinks cannot be used to read files outside the workspace.
- MCP file and directory requests use the MCP server root unless the request
  includes an explicit validated `root`. The bridge does not infer trust
  boundaries from arbitrary absolute file paths.
- Directory diagnostics are bounded by default: at most 50 source files, a
  15000 ms wall-clock budget, and 2 concurrent file diagnostics. Override these
  with `maxFiles`, `timeoutBudgetMs`, and `concurrency` when a wider scan is
  intentional. Results include directory metadata so truncated scans are not
  mistaken for full-workspace validation. Top-level `timedOut` means either
  the directory budget expired or at least one file diagnostic timed out;
  `directory.budgetTimedOut` only describes the directory scan budget.
- Directory scans keep a short in-process source-file-list cache for repeated
  MCP calls against the same directory and limit. Diagnostic results themselves
  are not cached, so edited file feedback still comes from the language server.
- Language servers are started lazily.
- Diagnostics are compressed into AI-readable summaries while preserving
  structured items.
- File diagnostics open the document, track the in-memory document version, and
  wait briefly for `textDocument/publishDiagnostics` before returning. Repeated
  diagnostics use `didChange` when the file contents changed instead of sending
  duplicate `didOpen` notifications.
- Workspace symbol requests first try known seed files, then scan for the first
  supported source file while skipping heavy generated directories such as
  `node_modules`, `.next`, `dist`, `build`, and `coverage`.
- Open documents are versioned with `didOpen`/`didChange`, closed with
  `didClose`, and re-synchronized after a language server restart.
- TypeScript definition uses source-definition when available, which avoids
  stopping at import aliases in common cases.
- Symbol-only commands can be ambiguous. File-position commands are more
  reliable for known occurrences.

## Security

`codex-lsp-bridge` does not intentionally execute project code. It starts local
language server processes and reads workspace files needed for document sync.

The installer modifies Codex config only when explicitly run. Use
`codex-lsp-bridge-install --dry-run` before writing config if you want to review
the changes.

Language servers are external executables. Install them from trusted sources.

## Development

```bash
npm install
npm run ci:verify
```

`ci:verify` runs type-checking, coverage tests, build, package file
verification, install/uninstall smoke tests, and a real tarball install smoke.
GitHub Actions runs the same command on Node 20 and 22 across Linux, macOS, and
Windows.

Release preparation is documented in [docs/RELEASE.md](./docs/RELEASE.md).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT. See [LICENSE](./LICENSE).
