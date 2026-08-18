# Codex Plugin Marketplace Notes

`codex-lsp-bridge` is packaged so it can be installed either through its npm
installer or through Codex plugin metadata.

## Positioning

Read-only LSP tools for Codex CLI.

The plugin provides semantic signals from local language servers without
granting write access or allowing workspace-root escape.

## Included Surfaces

- MCP server: `codex-lsp-bridge mcp`
- Hook: `hooks/hooks.json`
- Skill: `skills/lsp/SKILL.md`
- Plugin metadata: `.codex-plugin/plugin.json`
- MCP example: `.mcp.json`

## Expected User Flow

```bash
npm install -g codex-lsp-bridge
codex-lsp-bridge install
```

When a marketplace entry is available:

```bash
codex plugin add codex-lsp-bridge@<marketplace>
```

After install, restart Codex and use:

- `lsp_status`
- `lsp_diagnostics`
- `lsp_definition`
- `lsp_references`
- `lsp_symbols`
- `lsp_hover`

## Runtime Contract

Marketplace and plugin entry points must preserve the same runtime contract as
the installer:

- The bridge runtime resolves an approved native `node.exe` directly. Bare
  `node`, `node.cmd`, package-manager shims, and `node_repl.exe` are not valid
  bridge launchers.
- A language server may retain its own supported `.cmd` or `.bat` launcher.
- Explicit MCP tools work with automatic `PostToolUse` diagnostics disabled.
- The plugin does not create a resident broker or ask users to manage bridge
  processes.
- Process or load claims require the opt-in local measurement and attribution
  checks in [PROCESS-AND-LIFECYCLE.md](./PROCESS-AND-LIFECYCLE.md). An
  `INCONCLUSIVE` result is not a passing load result.

## Review Notes

- The plugin is read-only.
- It starts local language server processes configured by the user or PATH.
- It reads workspace files for LSP document synchronization.
- It rejects files outside the active workspace root after realpath checks.
- Detached worktrees require an explicit validated `root` argument.
- Rename and code action tools are intentionally not part of the MVP.

## Verification

```bash
npm run ci:verify
```

This verifies tests, build, npm pack contents, installer behavior, and a real
tarball install smoke.
