# Release Checklist

Use this checklist before publishing `codex-lsp-bridge`.

## Preflight

```bash
npm ci
npm run ci:verify
node dist/index.js doctor --root .
```

Expected:

- `ci:verify` passes type-check, coverage tests, build, package verification, install smoke, and package install smoke.
- `doctor` reports `distExists: true` and `stale: false`.
- `doctor.recommendations` is either empty or contains only environment-specific language-server install hints.

## Process and Lifecycle Rollout Gate

Before declaring the staged process-reuse work complete, verify the contract in
[PROCESS-AND-LIFECYCLE.md](./PROCESS-AND-LIFECYCLE.md) and
[the requirements plan](./2026-08-18-lsp-bridge-process-reuse-debate-and-plan.md):

- Generated local, updater, plugin, and hook configurations launch the bridge
  with an approved native `node.exe` directly.
- Explicit MCP diagnostics work while automatic `PostToolUse` diagnostics are
  disabled.
- Supported language-server `.cmd` and `.bat` launchers still work.
- Root and language reuse, isolation, recovery, concurrency, and bounded clean
  shutdown pass.
- Opt-in local measurement records only allowlisted lifecycle metrics and
  passes both negative and positive process-attribution controls.
- An `INCONCLUSIVE` workload or attribution result triggers repeat or extended
  measurement and cannot support a load-improvement claim.
- No persistent broker, idle-suspension mechanism, or Code Mode optimization is
  included in this rollout.

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
publication, or manually with workflow dispatch.

Required secret:

- `NPM_TOKEN`

Manual fallback:

```bash
npm run ci:verify
npm publish --access public
```

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
