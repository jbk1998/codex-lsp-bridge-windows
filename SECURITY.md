# Security Policy

## Supported Versions

Security fixes are provided for the latest published version.

## Reporting a Vulnerability

Please report security issues privately to the project maintainer or through the hosting platform's private vulnerability reporting flow when available.

Do not open a public issue for vulnerabilities that could expose user workspaces, credentials, or local system details.

## Security Model

`codex-lsp-bridge` is a local, read-only semantic context provider.

- It starts configured local language server processes.
- It reads files from the active workspace to synchronize documents with the language server.
- It does not intentionally execute arbitrary project code.
- The installer writes Codex configuration only when the user explicitly runs `codex-lsp-bridge-install`.

Language servers are external executables. Review and install them from trusted sources.
