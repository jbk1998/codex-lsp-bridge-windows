# codex-lsp-bridge

[![npm version](https://img.shields.io/npm/v/codex-lsp-bridge.svg)](https://www.npmjs.com/package/codex-lsp-bridge)
[![CI](https://github.com/jbk1998/codex-lsp-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/jbk1998/codex-lsp-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Read-only language-server tools for Codex. This bridge lets Codex ask the same
local LSPs your editor uses for diagnostics, definitions, references, workspace
symbols, and hover/type information, without giving Codex write access through
the language server.

This fork focuses on making the bridge practical on Windows and useful for real
Codex coding sessions:

- TypeScript/JavaScript diagnostics through `typescript-language-server`
- Python diagnostics through `pyright-langserver`
- Reliable Windows npm shim handling for `.cmd` language-server launchers
- Root-scoped CLI and MCP calls for detached worktrees and out-of-repo calls
- Clear metadata when diagnostics are clean, stale, timed out, or unavailable

The goal is not to replace full project checks like `tsc --noEmit`, `pyright`,
`ruff`, or test suites. The goal is to give Codex fast semantic feedback while
it is editing, reviewing, and refactoring code.

## Why Use It

Codex is strong at text search and patching, but many coding mistakes are
semantic:

- an import resolves in the editor but not in the target project
- a refactor updates the definition but misses a referenced call site
- a function accepts a narrower type than the surrounding code assumes
- a Python optional value is used as if it is always present
- a TypeScript file looks syntactically fine but publishes a semantic error

`codex-lsp-bridge` gives Codex a read-only semantic feedback layer so those
mistakes can be caught during the agent loop instead of only at the final build
or test step.

Typical loop:

1. Codex edits a supported source file.
2. The hook asks the matching local language server for diagnostics on touched
   files.
3. Codex sees compact semantic errors before it continues.
4. If diagnostics are stale or time out, the result says so instead of
   pretending there are no errors.

Example diagnostic signal:

```json
{
  "status": "ok",
  "timedOut": false,
  "stale": false,
  "total": 1,
  "summary": [
    "src/editor/store.ts:182 error Property 'id' does not exist on type..."
  ]
}
```

## What This Fork Does Well

- **Windows startup reliability.** npm language-server launchers on Windows are
  usually `.cmd` shims. This fork resolves local `node_modules/.bin`, `PATH`,
  and `PATHEXT`, rewrites common npm shims to direct Node entrypoints, and uses
  a safe `cmd.exe` wrapper only when needed.
- **TypeScript diagnostics.** The bridge can surface syntax and semantic
  diagnostics such as `TS1109` and `TS2322` from `typescript-language-server`.
- **Pyright diagnostics.** Python projects can get opened-file Pyright
  diagnostics through the same MCP interface.
- **Root-aware calls.** CLI and MCP callers can pass `--root` / `root` with a
  relative file path, which is important when Codex runs from a parent folder,
  a temp checkout, or a detached worktree.
- **Safe read-only posture.** Server-to-client edit requests are declined; the
  language server can inform Codex, but it cannot mutate the repository.
- **Honest status.** Missing servers, stale diagnostics, and timeouts are
  reported explicitly instead of being treated as a clean type check.

## Install In 30 Seconds

Install a language server for your project. For TypeScript:

```bash
npm install -g typescript-language-server typescript
```

For Python:

```bash
npm install -g pyright
```

For Rust:

```bash
rustup component add rust-analyzer
```

Install and register the Codex integration:

```bash
npm install -g codex-lsp-bridge
codex-lsp-bridge install --auto-update
codex-lsp-bridge doctor --root .
```

To install this fork before the changes land in the upstream npm package:

```bash
npm install -g github:jbk1998/codex-lsp-bridge
codex-lsp-bridge install
codex-lsp-bridge doctor --root .
```

For a Rust-first setup, the installer can ask `rustup` to install
`rust-analyzer` during setup:

```bash
npm install -g codex-lsp-bridge
codex-lsp-bridge install --auto-update --with-rust-analyzer
codex-lsp-bridge doctor --root .
```

Restart Codex. The `lsp_diagnostics`, `lsp_definition`, `lsp_references`,
`lsp_symbols`, `lsp_hover`, and `lsp_status` MCP tools are then available.

If you do not want a global install, use npm directly:

```bash
npx codex-lsp-bridge@latest install --auto-update
```

## Verify

From any project:

```bash
codex-lsp-bridge doctor --root .
codex-lsp-bridge diagnostics --file src/file.ts --timeout-ms 15000 --root .
```

On Windows, the bridge resolves local `node_modules/.bin` shims, `PATH` +
`PATHEXT` commands, and npm `.cmd` launchers before starting the language
server. If you run diagnostics from outside a project, pass `--root` and a
relative `--file`; the file is resolved under that root.

In Codex, ask it to check LSP status or diagnostics. After installation and
restart, Codex can call:

- `lsp_status`
- `lsp_diagnostics`
- `lsp_definition`
- `lsp_references`
- `lsp_symbols`
- `lsp_hover`

## What Codex Gets

- Read-only diagnostics with `status`, `timedOut`, `stale`, and
  `sourceRevision` metadata.
- Definition, references, symbols, and hover from local language servers.
- Position-based lookup for precise navigation when file/line/character is
  known.
- Quiet PostToolUse diagnostics for touched supported source files.
- Rust workspace detection through `Cargo.toml` and `.rs` hook coverage.
- Workspace-root boundaries with realpath checks, including symlink escape
  protection.

Diagnostics are LSP diagnostics for opened files, not a replacement for full
project validation commands such as `tsc --noEmit`, `ruff`, or `pyright` CLI
runs.

## Status

The MVP is intentionally narrow and ready for local always-on use.

- Read-only first
- TypeScript remains the primary path
- Rust adapter and hook coverage are supported experimentally
- Python and Go adapters are present but less exercised
- No broad automatic language server installation; `--with-rust-analyzer` is a
  narrow explicit Rust setup helper
- No rename/code-action support yet

## Requirements

- Node.js 20+
- Codex CLI with MCP support
- Local language server executable for the language you want to use

| Language | Support | Required command | Hook coverage | Install hint |
| --- | --- | --- | --- | --- |
| TypeScript / JavaScript | Primary | `typescript-language-server` | `.ts`, `.tsx`, `.js`, `.jsx` | `npm install -g typescript-language-server typescript` |
| Rust | Experimental | `rust-analyzer` | `.rs` | `rustup component add rust-analyzer` |
| Python | Experimental | `pyright-langserver` | `.py` | `npm install -g pyright` |
| Go | Experimental | `gopls` | `.go` | `go install golang.org/x/tools/gopls@latest` |

For TypeScript projects, install a language server if needed:

```bash
npm install -g typescript-language-server typescript
```

For Rust projects, install `rust-analyzer` if needed:

```bash
rustup component add rust-analyzer
```

For Rust repos where contributors should get the same component naturally,
make `rust-toolchain.toml` the project source of truth:

```toml
[toolchain]
channel = "stable"
components = ["rust-analyzer"]
```

`lsp_status` and `codex-lsp-bridge doctor --root .` report the detected
language-server command, support level, seed file, install hint, and actionable
recommendations for missing setup.

## Install Options

Recommended install:

```bash
npm install -g codex-lsp-bridge
codex-lsp-bridge install --auto-update
```

Rust-first install that also asks `rustup` to install `rust-analyzer` when it is
missing:

```bash
npm install -g codex-lsp-bridge
codex-lsp-bridge install --auto-update --with-rust-analyzer
```

One-shot install through npm:

```bash
npx codex-lsp-bridge@latest install --auto-update
```

One-shot Rust-first install:

```bash
npx codex-lsp-bridge@latest install --auto-update --with-rust-analyzer
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
- `~/.codex/hooks.json`: `PostToolUse` hook for touched supported source-file diagnostics
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
recognizable workspace containing `.git`, `package.json`, `tsconfig.json`, or
`Cargo.toml`.

The hook runs after edit tools and checks touched supported source files:

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
If the touched file's language server is not installed, the hook skips that file
quietly by default so a contributor without optional language tooling is not
blocked.

Rust files use the same hook path as TypeScript files. A touched `.rs` file
calls `codex-lsp-bridge diagnostics --file <file> --root <workspace>`, which
auto-detects Rust from the extension and starts `rust-analyzer` lazily. Missing
`rust-analyzer` is treated as unavailable language tooling, not as a successful
clean diagnostic result.

Hook output is intentionally quiet:

- clean files print one short line
- `timed_out` with no diagnostics is silent by default
- `CODEX_LSP_HOOK_VERBOSE_PENDING=1` prints pending or skipped language-server
  details
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
codex-lsp-bridge diagnostics --file src/file.ts --timeout-ms 15000 --root .
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
codex-lsp-bridge definition --file src/main.rs --line 12 --character 8 --root .
codex-lsp-bridge references --file src/main.rs --line 12 --character 8 --root .
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
  "conclusion": "diagnostics_clean",
  "message": "No LSP diagnostics were returned for this request; this is not a full project type-check.",
  "timedOut": false,
  "stale": false,
  "sourceRevision": 1
}
```

`status: "timed_out"` means the bridge did not receive fresh
`textDocument/publishDiagnostics` before the timeout. Treat that differently
from "no diagnostics". A timed-out result uses `conclusion: "inconclusive"`
and must not be treated as type-check passed.

`conclusion: "diagnostics_clean"` means the LSP diagnostics request returned no
diagnostics. It is not the same as a full project `tsc --noEmit` or equivalent
type-check passing.

`status: "unavailable"` means the selected language server could not be
started, commonly because the required command is not installed. Treat that as
missing setup, not as a passing semantic check.

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

For file diagnostics in large workspaces, pass `timeoutMs` when the default
`diagnosticsTimeoutMs` is too short:

```json
{
  "name": "lsp_diagnostics",
  "arguments": {
    "root": "/path/to/workspace",
    "file": "/path/to/workspace/src/file.ts",
    "timeoutMs": 15000
  }
}
```

`timeoutBudgetMs` is only for directory diagnostics. File diagnostics reject it
so a mistyped timeout option does not silently produce a shorter wait.

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

Use global config for your personal default and workspace config for large
repos that need longer language-server warmup. For a Rust-first workspace:

```json
{
  "defaultLanguage": "rust",
  "diagnosticsTimeoutMs": 15000,
  "hook": {
    "maxFiles": 5,
    "verbosePending": false
  },
  "languageServers": {
    "rust": {
      "command": "rust-analyzer",
      "args": []
    }
  }
}
```

For large monorepos, let the bridge choose a bounded timeout from lightweight
workspace hints:

```json
{
  "diagnosticsTimeoutMs": "auto"
}
```

Auto mode starts at 15000 ms and increases for monorepo markers, TypeScript
project references, and large sampled source trees. It is capped at 60000 ms.
`codex-lsp-bridge doctor --root .` reports the resolved timeout and reasons.

File diagnostics can also override the wait per call:

```bash
codex-lsp-bridge diagnostics --file src/file.ts --timeout-ms 30000 --root .
```

For MCP tool calls, pass `timeoutMs` on `lsp_diagnostics`. Directory diagnostics
use `timeoutBudgetMs` instead because they have a scan-wide wall-clock budget.

For TypeScript, a workspace-local
`node_modules/.bin/typescript-language-server` is preferred when present, then
the configured command or PATH command is used. Rust uses the configured
`rust-analyzer` command or the PATH command.

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
semantic feedback from supported source files. After editing supported source
files, call `lsp_diagnostics` for touched files before broader verification.
Before renames, moves, signature changes, or multi-file semantic refactors,
call `lsp_definition` and `lsp_references`. Prefer file-position inputs over
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
