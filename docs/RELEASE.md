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
