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

### Process and Lifecycle Changes

Keep the bridge runtime and the language-server launcher separate:

- Bridge MCP, updater, and hook launch paths must resolve an approved native
  `node.exe` directly. Do not use a bare `node`, `node.cmd`, another command
  shim, or `node_repl.exe` for the bridge runtime.
- Preserve supported `.cmd` and `.bat` launchers when they belong to the
  configured language server itself.
- Preserve one manager per workspace root and one provider per language within a
  live MCP process. Do not add cross-connection persistence, a resident broker,
  or idle suspension without a separate evidence-backed scope decision.
- Keep automatic `PostToolUse` diagnostics disabled during the process and load
  baseline. Explicit MCP diagnostics must remain usable without the hook.
- Use only an opt-in local diagnostic harness for baseline evidence. Do not
  persist source contents, document text, credentials, or unrelated process
  data. Include negative and positive process-attribution controls and report
  `INCONCLUSIVE` when ownership or workload representativeness cannot be proven.

The repository-local harness is `scripts/measure-bridge-lifecycle.mjs`. It is
not a package bin, MCP surface, hook, or resident service. Run its tests with
`npm run test:run -- tests/measurement.test.ts`; native Windows process,
resource, identity, and simultaneous-control evidence remains a maintainer
acceptance step.

See [docs/PROCESS-AND-LIFECYCLE.md](./docs/PROCESS-AND-LIFECYCLE.md) for the
full acceptance contract.

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
- For installer, plugin, or hook changes, verify the generated launch commands
  and the native-runtime contract on Windows.

## Release

See [docs/RELEASE.md](./docs/RELEASE.md).
