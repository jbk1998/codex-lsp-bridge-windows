# Repository Settings

These settings protect changes that cannot be enforced from the source tree.

## `main` ruleset

Create an active branch ruleset targeting the default branch, then configure:

- require a pull request before merging;
- require at least one approving review;
- dismiss stale approvals when new commits are pushed;
- require all review conversations to be resolved;
- require these status checks:
  - `test (ubuntu-latest, 22)`;
  - `test (ubuntu-latest, 24)`;
  - `test (windows-latest, 22)`;
  - `test (windows-latest, 24)`;
  - `integration (typescript + pyright)`;
  - `windows acceptance`;
- require branches to be up to date before merging;
- block force pushes and branch deletion;
- do not allow bypass except for an explicitly documented emergency role.

The check names above come from `.github/workflows/ci.yml`. Update this list and
the ruleset together whenever a job name changes.

## npm trusted publisher

Before creating a release tag, bind the `codex-lsp-bridge` npm package to:

- repository: `jbk1998/codex-lsp-bridge-windows`;
- workflow: `.github/workflows/release.yml`;
- environment: none.

The release workflow deliberately has no long-lived npm token fallback and will
fail closed until this registry-side binding exists.
