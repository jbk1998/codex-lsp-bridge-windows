# Contributing

Thanks for helping improve `codex-lsp-bridge`.

## Development

```bash
npm install
npm run type-check
npm test
npm run build
```

## Scope

The project is read-only first. Prefer semantic context features such as diagnostics, definitions, references, symbols, and hover information before adding edit/refactor operations.

Do not add fallback branches or permissive alternate paths to hide LSP failures. Fix the canonical flow or surface a clear error.

## Pull Requests

- Keep changes narrowly scoped.
- Add or update tests for behavior changes.
- Run `npm run type-check`, `npm test`, and `npm run build`.
- Document new user-facing commands or install behavior in `README.md`.
