---
title: Making the bridge reliable across arbitrary folders and workspace roots
type: research
date: 2026-08-20
status: findings
---

# Making the bridge reliable across arbitrary folders and workspace roots

## Finding

The bridge does not need `package.json` to make an arbitrary folder usable. The
Language Server Protocol does not define a workspace-root discovery algorithm.
The client chooses the root it sends to the server. TypeScript separately
decides whether an opened file belongs to a configured project or an inferred
project.

The safest design is therefore to separate three decisions:

1. Which exact directory the bridge is allowed to serve.
2. Which project configuration, if any, the language server finds inside that
   directory or its parents.
3. Which language-server process owns that root and its open documents.

The follow-up implementation applies the P0 root-policy and initialization
changes described below. This note records the source-backed rationale and the
remaining limits.

## What the primary sources establish

### LSP root semantics

The LSP `initialize` request makes `rootUri` the canonical single-root field;
`rootPath` is deprecated, and `rootUri` wins if both are supplied. `rootUri` may
be `null` when no folder is open. `workspaceFolders` is optional and is sent
only when the client supports workspace folders. It may also be `null` when the
client supports the feature but no folders are configured. See the official
[LSP initialize specification](https://raw.githubusercontent.com/microsoft/language-server-protocol/gh-pages/_specifications/lsp/3.17/general/initialize.md).

For a client that supports workspace folders, the specification defines a
`workspace/workspaceFolders` request and a `WorkspaceFolder` as a URI plus a
display name. It does not require a package file, VCS directory, or any other
marker. See the official [LSP workspace folders specification](https://raw.githubusercontent.com/microsoft/language-server-protocol/gh-pages/_specifications/lsp/3.17/workspace/workspaceFolders.md).

The protocol also says that one server serves one tool and that the client
manages server lifecycle. That does not force one process per folder, but it
supports keeping each bridge server process bound to one exact root when root
isolation matters. See [LSP implementation considerations](https://raw.githubusercontent.com/microsoft/language-server-protocol/gh-pages/_specifications/lsp/3.17/specification.md#languageServerProtocol).

### TypeScript project selection

TypeScript treats a `tsconfig.json` as the root of a TypeScript project and a
`jsconfig.json` as the equivalent JavaScript project marker. The compiler looks
for `tsconfig.json` from the current directory up the parent chain when no
input files are supplied. See the official [tsconfig documentation](https://www.typescriptlang.org/docs/handbook/tsconfig-json.html).

When a `.ts` or `.js` file has no `tsconfig.json` or `jsconfig.json` in its
directory or any parent, `tsserver` creates an inferred project. That project
starts with the loose file and follows its triple-slash references and module
imports transitively. It uses inferred-project defaults unless the host sets
them. An inferred project is not a promise to index every file below the
workspace root. See the official [tsserver project-system documentation](https://github.com/microsoft/TypeScript/wiki/Standalone-Server-%28tsserver%29#project-system).

The TypeScript server protocol exposes
`compilerOptionsForInferredProjects`. The command is listed in the official
[TypeScript server protocol](https://github.com/microsoft/TypeScript/blob/main/src/server/protocol.ts).
The upstream [typescript-language-server spawner](https://github.com/typescript-language-server/typescript-language-server/blob/master/src/tsServer/spawner.ts)
also starts `tsserver` with `--useInferredProjectPerProjectRoot`, which is the
right default for keeping unrelated inferred roots apart inside that process.

For JavaScript, `allowJs` permits JavaScript files to participate in a project;
`checkJs` controls whether JavaScript errors are reported. The official
[allowJs and checkJs reference](https://www.typescriptlang.org/tsconfig/checkJs.html)
supports keeping `checkJs` off by default while honoring `// @ts-check` and
explicit project settings.

TypeScript normally sees `@types` packages in enclosing `node_modules` folders.
If `typeRoots` is set, only the listed roots are searched. If `types` is set,
only the named packages contribute globals. See the official [typeRoots reference](https://www.typescriptlang.org/tsconfig/typeRoots.html)
and [types reference](https://www.typescriptlang.org/tsconfig/types).

## Assessment and follow-up implementation

The current implementation already has most of the hard safety machinery:

- `src/core/workspace-root.ts` canonicalizes real paths, walks upward from
  absolute targets, and rejects file paths that leave the selected root.
- `src/index.ts` keeps managers keyed by canonical root identity and detects a
  delete-and-recreate of the same path.
- `src/core/lsp-manager.ts` keeps one provider per language within each root.
- `src/core/lsp-semantic-provider.ts` sends `rootUri` and one
  `workspaceFolders` entry, uses the root as the server `cwd`, and checks all
  returned locations against that root.
- `src/core/typescript-project.ts` supplies inferred-project options and a
  bounded Node type-declaration fallback for standalone JavaScript or ESM
  files.
- `src/core/json-rpc-lsp-client.ts` has a Windows-specific path for `.cmd` and
  `.bat` language-server shims. Node's documentation confirms that these files
  need a shell or an explicit `cmd.exe` wrapper on Windows; direct JavaScript
  entrypoints remain preferable. See [Node child-process documentation](https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows).

Before the follow-up patch, the main gaps were policy consistency and protocol
completeness:

- The MCP `root` path currently goes through marker validation, so an
  explicitly named markerless directory can be rejected even though the CLI
  path can serve one.
- `jsconfig.json` is not in the root marker list even though TypeScript treats
  it as a project root.
- The provider sends `workspaceFolders` but its client capabilities do not
  advertise `workspace.workspaceFolders`, and the generic server-request
  response currently returns `null` for `workspace/workspaceFolders`. A fixed
  one-root server should either implement this request and advertise the
  capability, or omit `workspaceFolders` entirely.
- Automatic discovery treats context files such as `AGENTS.md`, `CLAUDE.md`,
  and `SKILL.md`, plus `.git`, as root markers. That is useful for isolated
  skill folders, but those files are not language-project boundaries. Applying
  the same rule to ordinary source files can select a much larger parent than
  necessary.
- The inferred TypeScript defaults are more opinionated than the upstream
  language server's basic inferred-project defaults. In particular,
  `moduleResolution: "bundler"`, `module: "preserve"`, and a forced target may
  be wrong for a standalone Node script. They should not affect configured
  projects, and they should be configurable or reduced to a conservative
  baseline for inferred projects.

## Recommended root-selection contract

Use this order and record the selected mode for diagnostics and troubleshooting.

1. **Explicit root.** If the caller supplies `root` or `--root`, resolve it to
   an existing directory, canonicalize it through the real path, and accept it
   even when it has no marker. Do not walk above it. The caller has named the
   security boundary.
2. **Absolute directory target.** If the caller supplies an absolute `dir`
   without an explicit root, use the nearest strong project marker. If none is
   found, use that exact directory, not its parent.
3. **Absolute file target.** If the caller supplies an absolute file without an
   explicit root, use the nearest strong project marker. If none is found, use
   the file's containing directory as an ephemeral root.
4. **Relative target.** Keep the existing startup-root behavior and reject any
   resolved target outside that root. Do not turn a relative path into an
   upward search from the current file because the caller did not provide an
   independent absolute boundary.
5. **No target.** Use the explicitly selected startup root. If no trusted root
   exists, fail closed instead of choosing a home directory, drive root, or
   repository ancestor.

Strong automatic markers should include `.lsp-root`, `tsconfig.json`,
`jsconfig.json`, `package.json`, `Cargo.toml`, `pyproject.toml`,
`pyrightconfig.json`, `go.mod`, `go.work`, and the existing language-specific
markers. Keep `SKILL.md` as a deliberate skill-folder boundary if that behavior
is required. Treat `.git`, `AGENTS.md`, and `CLAUDE.md` as weak context hints,
not ordinary source-project roots. A weak marker must not cause an absolute
file request to expand to a large repository or user directory.

Every selected root should carry a source label such as `explicit`, `marker`,
`ephemeral`, or `startup`. That makes a surprising root explainable without
weakening the boundary check.

## Recommended LSP initialization contract

Keep one language-server process per canonical root and language. Initialize it
with:

- the canonical `rootUri`;
- one `workspaceFolders` item for that same root; and
- `workspace.workspaceFolders: true` in client capabilities.

Answer `workspace/workspaceFolders` with that same one-item list. Do not accept
server-originated root changes. If a caller selects another root, dispose the
old manager and create a new root-scoped manager. Do not place multiple
unrelated roots in one server merely to reduce process count.

Keep `rootPath` only if compatibility testing proves a server still needs it.
It is deprecated by the protocol. If `workspaceFolders` support is not going
to be implemented, remove both the capability and the initialization property
instead of sending a value that the client cannot answer consistently.

The existing root identity and per-language provider maps are the right shape.
Add tests that open identical filenames in two markerless roots with different
configs, run requests concurrently, and verify distinct `rootUri`, `cwd`,
document registries, diagnostics, and shutdown behavior.

## Recommended TypeScript behavior

- Add `jsconfig.json` to discovery and let a discovered `tsconfig.json` or
  `jsconfig.json` remain authoritative. Never synthesize or write a config file
  into a user folder.
- For a markerless TypeScript or JavaScript root, rely on the language server's
  inferred project. Send `compilerOptionsForInferredProjects` before opening
  the first document, but apply those options only to inferred projects.
- Prefer the upstream conservative baseline for inferred projects:
  `allowJs`, `allowNonTsExtensions`, `allowSyntheticDefaultImports`, and
  `resolveJsonModule`. Keep `checkJs` false by default so standalone JavaScript
  does not suddenly produce a new class of diagnostics. Make module mode,
  module resolution, target, JSX, and strictness explicit per root if they are
  needed.

The follow-up patch addresses the first three root and protocol gaps: explicit
existing directories are accepted, markerless absolute targets use their exact
containing directory, `jsconfig.json` is a recognized marker, and the client
advertises and answers the single-root `workspaceFolders` contract. The
remaining TypeScript inferred-project recommendations are intentionally
separate from root selection and require their own compatibility tests.
- Resolve Node declarations through an explicit, documented allowlist. A
  bundled `@types/node` fallback is useful for standalone scripts, but it is a
  type-dependency exception, not permission to serve that dependency's parent
  directory as a workspace.
- Consider passing `initializationOptions.tsserver.path` for a root-local
  TypeScript installation and `fallbackPath` for the bridge's packaged copy.
  The upstream [typescript-language-server configuration](https://github.com/typescript-language-server/typescript-language-server/blob/master/docs/configuration.md#tsserver-options)
  documents both settings. Report which TypeScript version was selected.

## Limitations

- LSP specifies how roots are communicated, not how a client discovers them.
  Marker precedence and markerless fallback are bridge policy and need regression
  tests.
- An inferred project starts from opened files and their dependency graph. It
  may not provide complete workspace symbols or diagnostics for unrelated files
  until those files are opened or a real project config exists.
- A root boundary protects bridge requests, opened documents, locations, and
  directory scans. TypeScript may still read standard libraries, visible type
  declarations, and imported dependencies outside the root. Keep those reads
  explicit and bounded; do not describe them as a workspace-root expansion.
- Per-root isolation costs more processes than a shared multi-root server. The
  tradeoff is deliberate: it prevents project settings, inferred-project state,
  diagnostics, and document ownership from crossing roots.
- A markerless folder with no local dependencies can receive syntax and basic
  language-service results, but no bridge can infer the intended framework,
  runtime, aliases, or package types reliably without configuration.

## Implementation priority

1. **P0: make root policy consistent.** Permit explicit markerless directories;
   add `jsconfig.json`; add exact-directory and file-parent fallback for
   markerless absolute targets; keep relative targets inside the startup root;
   and classify weak markers so they cannot broaden roots unexpectedly.
2. **P0: make initialization protocol-correct.** Advertise and answer the
   single-root `workspaceFolders` contract, or remove the property and
   capability together. Keep canonical `rootUri` and test Windows file-URI
   round trips.
3. **P1: preserve TypeScript project intent.** Separate configured-project
   behavior from inferred-project defaults, reduce or configure aggressive
   inferred compiler options, and verify local TypeScript plus fallback
   TypeScript selection.
4. **P1: prove isolation.** Add concurrent two-root tests for manager keys,
   server initialization, document and diagnostic state, path traversal,
   symlinks, root replacement, and disposal.
5. **P2: improve observability and docs.** Surface root-selection mode,
   canonical root, selected TypeScript version, and inferred versus configured
   project status in doctor or debug output. Keep directory scans bounded by the
   existing file, concurrency, and timeout limits.

## Primary sources

- [LSP 3.17 initialize request](https://raw.githubusercontent.com/microsoft/language-server-protocol/gh-pages/_specifications/lsp/3.17/general/initialize.md)
- [LSP 3.17 workspace folders](https://raw.githubusercontent.com/microsoft/language-server-protocol/gh-pages/_specifications/lsp/3.17/workspace/workspaceFolders.md)
- [LSP 3.17 specification](https://raw.githubusercontent.com/microsoft/language-server-protocol/gh-pages/_specifications/lsp/3.17/specification.md)
- [TypeScript tsconfig.json documentation](https://www.typescriptlang.org/docs/handbook/tsconfig-json.html)
- [TypeScript standalone server project system](https://github.com/microsoft/TypeScript/wiki/Standalone-Server-%28tsserver%29#project-system)
- [TypeScript server protocol](https://github.com/microsoft/TypeScript/blob/main/src/server/protocol.ts)
- [TypeScript allowJs and checkJs](https://www.typescriptlang.org/tsconfig/checkJs.html)
- [TypeScript typeRoots](https://www.typescriptlang.org/tsconfig/typeRoots.html)
- [TypeScript types](https://www.typescriptlang.org/tsconfig/types)
- [typescript-language-server configuration](https://github.com/typescript-language-server/typescript-language-server/blob/master/docs/configuration.md)
- [typescript-language-server TypeScript server spawner](https://github.com/typescript-language-server/typescript-language-server/blob/master/src/tsServer/spawner.ts)
- [Node.js child process documentation](https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows)
