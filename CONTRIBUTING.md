# Contributing

Thanks for helping improve `codex-lsp-bridge`.

## Development

```bash
npm install
npm run ci:verify
```

## Scope

The project is read-only first. Prefer semantic context features such as diagnostics, definitions, references, symbols, and hover information before adding edit/refactor operations.

Do not add fallback branches or permissive alternate paths to hide LSP failures. Fix the canonical flow or surface a clear error.

### Maintainer Triage

Good fit:

- Diagnostics reliability, including `timedOut`, `stale`, and `sourceRevision` correctness.
- Workspace-root boundary hardening and symlink escape prevention.
- Installer, uninstall, Codex MCP config, and hook UX improvements.
- Read-only semantic tools that help Codex avoid incorrect edits.
- Language-server compatibility improvements with clear reproduction steps.
- Documentation that improves installation, verification, or troubleshooting.

Needs careful design:

- Rename, code actions, or any write-capable workflow.
- Persistent indexing, graph extraction, or long-running background databases.
- GitHub, GitLab, or PR automation beyond accepting changed file lists as input.
- New language adapters without a minimal diagnostics integration path.

Out of scope:

- Arbitrary command execution.
- Reading files outside the configured workspace root.
- Silent fallbacks that make "unknown", "timed out", or "stale" look like success.
- Write-by-default behavior.
- IDE/editor replacement features.

For diagnostics issues, ask for:

- Exact CLI command or MCP tool arguments.
- Full diagnostics response including `status`, `timedOut`, `stale`, and `sourceRevision`.
- `codex-lsp-bridge doctor --root .` output.
- Language server version and install path.
- Workspace shape, especially monorepos, project references, package manager, and config files.

For security concerns involving workspace escape, arbitrary execution, or secrets, move the report to the security policy instead of debugging sensitive details in a public issue.

## Pull Requests

- Keep changes narrowly scoped.
- Add or update tests for behavior changes.
- Run `npm run ci:verify`.
- Document new user-facing commands or install behavior in `README.md`.

## Release

See [docs/RELEASE.md](./docs/RELEASE.md).
