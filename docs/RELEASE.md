# Release Checklist

Use this checklist before publishing `codex-lsp-bridge`.

## Preflight

```bash
npm ci
npm run ci:verify
<approved-native-node.exe> dist/index.js doctor --root .
```

On a Windows runner, also run the native acceptance suite:

```powershell
node scripts/windows-acceptance.mjs
```

It launches real Node children through `.cmd` and `.bat` wrappers, verifies
native process-identity teardown, records the fixture working set before and
after idle suspension, and confirms that the next MCP request cold-starts a
fresh provider. The suite is skipped on non-Windows hosts. Keep this command as
an explicit Windows CI step so the regular cross-platform unit suite cannot
silently substitute for native evidence.

Expected:

- `ci:verify` passes type-check, coverage tests, build, package verification, install smoke, and package install smoke.
- `doctor` reports `distExists: true` and `stale: false`.
- `doctor.codex.explicitMcpReady` is true for the generated native config, and
  `doctor.codex.hookState` is `absent` or an explicitly preserved user-owned
  state. Recommendations may include language-server, install, build, or
  enabled-hook guidance.

## Process and Lifecycle Rollout Gate

Before declaring the staged process-reuse work complete, verify the contract in
[PROCESS-AND-LIFECYCLE.md](./PROCESS-AND-LIFECYCLE.md) and
[the requirements plan](./2026-08-18-lsp-bridge-process-reuse-debate-and-plan.md):

- Installer-generated local, updater, and future hook configurations launch the
  bridge with an approved native `node.exe` directly. Static plugin metadata is
  template-only and must be materialized by the installer before activation.
- Explicit MCP diagnostics work while automatic `PostToolUse` diagnostics are
  disabled.
- Supported language-server `.cmd` and `.bat` launchers still work.
- Root and language reuse, isolation, recovery, concurrency, and bounded clean
  shutdown pass.
- Opt-in local measurement records only allowlisted lifecycle metrics and
  passes both negative and positive process-attribution controls.
- The repository-local harness is absent from package output and emits one
  receipt only for completed runs. An `INCONCLUSIVE` workload or attribution
  result triggers repeat or extended measurement and cannot support a
  load-improvement claim; `HARNESS_ERROR` produces no receipt.
- Idle suspension remains bounded, waits for active requests, keeps the MCP
  connection open, and lazily recreates providers on the next request. No
  persistent broker, cross-connection reuse, or Code Mode optimization is
  included in this rollout.
- The default managed PostToolUse hook remains absent or disabled. The active
  per-file wrapper and deferred batching/IPC helper have separate
  characterization coverage and are not baseline acceptance evidence.

## Version

1. Update `package.json` version.
2. Update `CHANGELOG.md`.
3. Commit with `chore: release vX.Y.Z`.
4. Tag the commit:

```bash
git tag vX.Y.Z
git push origin main --tags
```

## Publish

Publishing is handled by `.github/workflows/release.yml` on GitHub release
publication, or manually with workflow dispatch (`publish: true`). The workflow
uses npm trusted publishing: GitHub's short-lived OIDC identity authenticates the
publish, so no long-lived `NPM_TOKEN` or `NODE_AUTH_TOKEN` is stored or passed to
the job. npm provenance is generated automatically by the trusted-publishing
client.

The repository cannot inspect npm's registry-side trusted-publisher settings.
Before the first publish, configure the npm package `codex-lsp-bridge` with this
exact trusted publisher binding:

- GitHub owner and repository: `jbk1998/codex-lsp-bridge-windows`
- Workflow file: `.github/workflows/release.yml`
- GitHub environment: none (if an environment is added later, update both the
  npm binding and the workflow deliberately)
- Workflow permissions: `contents: read` and `id-token: write`

The workflow installs npm `11.19.1` on Node 22 before verification and publishing;
npm trusted publishing requires a compatible npm 11.x client. If the registry
binding is missing or does not match, the publish step fails with an actionable
configuration error rather than falling back to a token.

Manual emergency publishing should be performed from a trusted maintainer
machine after `npm login`, never by adding a repository secret to the workflow:

```bash
npm run ci:verify
npm publish --access public
```

If a legacy npm automation token exists from an earlier release process, revoke
it at npm and issue a replacement only for a separately approved emergency
workflow. Do not reintroduce `NPM_TOKEN` to the trusted-publishing job.

## Post-Publish Smoke

```bash
npx codex-lsp-bridge@latest install --dry-run
npx codex-lsp-bridge@latest doctor --root .
npx codex-lsp-bridge@latest uninstall --dry-run
```

## Codex Plugin Marketplace

The repository already ships:

- `.codex-plugin/plugin.json`
- `.mcp.json`
- `hooks/hooks.json`
- `skills/lsp/SKILL.md`

Before submitting to a marketplace, verify the marketplace entry points at the
published npm package and that a clean Codex profile can install and remove it
without manually editing `~/.codex`.
