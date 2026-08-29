# Security Policy

## Supported Versions

Security fixes are provided for the latest published version.

## Reporting a Vulnerability

Please report security issues privately to the project maintainer or through the hosting platform's private vulnerability reporting flow when available.

Do not open a public issue for vulnerabilities that could expose user workspaces, credentials, or local system details.

## Security Model

`codex-lsp-bridge` is a local, read-only semantic context provider.

- It starts configured local language server processes. Workspace-local
  `node_modules/.bin` servers are executable code from the checked-out
  dependency tree and must be treated accordingly.
- It reads files from the active workspace to synchronize documents with the language server.
- Workspace config can tune diagnostics and lifecycle behavior, but it cannot
  override the language-server executable or arguments. Those process overrides
  are read only from the user's global Codex config.
- The installer writes Codex configuration only when the user explicitly runs `codex-lsp-bridge-install`.

Language servers are external executables. Review and install them from trusted
sources, and use the bridge only with repositories and installed dependencies
you trust.
