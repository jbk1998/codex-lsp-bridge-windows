# Repository Audit and Hardening Plan

Date: 2026-08-29

Baseline: `main` at `05b9dcca864519fbb29a6214dd88fd02e616a6eb`
(`feat: add idle LSP resource suspension`, pushed 2026-08-28 22:02:38 UTC)

## Objective

Make the Windows-focused bridge safer to run in checked-out repositories, make
idle suspension and shutdown truthfully report process ownership, align the
public contract with actual behavior, and strengthen verification without
expanding the read-only LSP surface.

## Baseline Evidence

- GitHub CI run 45 passed on the baseline commit.
- Local `npm ci` completed successfully.
- Local `npm run ci:verify` passed with 177 tests passing and 8 external-server
  integration tests skipped.
- `npm audit` reported zero known production or development vulnerabilities.
- The repository had no open issues or pull requests.
- `main` was unprotected at audit time.
- Baseline coverage was 82.33% statements, 72.38% branches, 92.03% functions,
  and 86.49% lines. Process ownership was the largest high-risk low-coverage
  area at 49.56% lines.

## Prioritized Findings

### P0: Idle suspension can lose process ownership

`LspManager.suspend()` removed providers before knowing whether disposal was
clean. On Windows, a wrapper may intentionally fail closed with
`descendant_unverified`; the old provider then became unreachable, a later
request could launch another server, and final shutdown could incorrectly
report clean.

Acceptance criteria:

- Non-cleanly disposed providers remain tracked.
- Final disposal retries a bounded cleanup attempt when safe.
- Final results preserve non-clean ownership evidence.
- A regression test covers suspend failure, provider rehydration, and shutdown.

Status: implemented in this change.

### P0: EOF can race or hang behind idle suspension

The transport could schedule suspension after EOF had begun shutdown, and it
awaited an in-flight suspension before entering the lifecycle coordinator. A
hanging callback could therefore bypass the coordinator's bounded shutdown.

Acceptance criteria:

- EOF immediately disables pending idle actions.
- Suspension is scheduled only while lifecycle state is `open`.
- Shutdown enters the bounded lifecycle coordinator without first awaiting a
  suspension callback.
- Regression tests cover pending suspension at EOF and a hanging suspension.

Status: implemented in this change.

### P0: Workspace config controls process execution

Repository-owned `.codex/lsp-client.json` could override both a language-server
command and its arguments. Opening an untrusted checkout and requesting LSP
data could therefore launch an arbitrary command selected by repository
content.

Acceptance criteria:

- Only the user-owned global Codex config may set language-server commands and
  arguments.
- Workspace config may continue to tune non-executable behavior.
- Tests prove a workspace cannot replace or add executable overrides.
- README and security policy disclose that project-local dependency binaries
  are still executable code and require a trusted workspace.

Status: implemented in this change.

### P1: MCP validation silently widens invalid directory scans

Invalid `maxFiles`, `timeoutBudgetMs`, or `concurrency` values fell back to
defaults; an invalid severity produced misleading empty results. The transport
should reject bad inputs rather than execute a broader scan than requested.

Status: implemented with positive-integer and severity validation tests.

### P1: Public and runtime contracts drifted

- MCP initialize reported version `0.1.0` while the package was `0.3.3`.
- The CI badge and GitHub install command pointed to the non-Windows repository.
- README and contributor/release text contradicted actual idle suspension and
  CI platforms.
- README claimed `.cjs` support, but explicit and directory language detection
  omitted it.
- `doctor` ignored the same trusted executable override used at runtime.
- npm changed tracked bin scripts to executable during installation because
  their committed modes did not match their package-bin role.

Status: implemented and covered where executable behavior is involved.

### P1: Supported runtime and CI policy were inconsistent

The package claimed Node 20 support after Node 20 reached end of life, while
repository instructions named Node 22 and 24 and CI tested only Node 22.

Status: the package now requires Node 22+, and CI verifies Node 22 and 24 on
Ubuntu and Windows with read-only contents permission and no persisted checkout
credential.

### P2: Follow-up robustness work

The follow-up pass completed every source-controlled robustness item:

1. Define whether idle timeout is a connection-startup policy or can change when
   an MCP request selects another workspace root; then align config docs and add
   multi-root tests.
2. Add bounded MCP input-line size, in-flight request limits, and outgoing LSP
   payload limits to reduce
   local memory-denial risk.
3. Add generation-scoped LSP stdin error handling so asynchronous `EPIPE`
   failures reject pending work instead of becoming uncaught stream errors.
4. Close remaining path-validation TOCTOU windows by reading through a verified
   file descriptor or revalidating the opened target immediately before content
   is sent to a language server.
5. Add a manager-registry abstraction that removes completed retired managers
   from the long-lived root map and makes root-replacement cleanup unit-testable.
6. Handle malformed global and workspace JSON config with path-specific,
   actionable diagnostics. Decide explicitly whether malformed workspace config
   is ignored or blocks operation.
7. Add formatting/lint enforcement and raise coverage specifically for
   `process-ownership.ts`, native runtime validation, and index-level manager
   orchestration.
8. Add a CI integration job with pinned TypeScript/Pyright server dependencies
   and explicit accounting for skipped external-server tests.
9. Add real Windows acceptance coverage for `.cmd`/`.bat` descendant ownership,
   native process identity, idle memory reduction, and post-suspension cold start.
10. Move npm publishing fully to trusted publishing if the registry is configured
   for it; otherwise remove unused OIDC permission and document token rotation.
11. Enable a `main` ruleset requiring the CI job and pull-request review. This is
   a repository setting, not a source-tree change.

Status:

1. The idle timeout is now explicitly a connection-startup policy, with
   multi-root tests and matching documentation.
2. MCP input, output, request concurrency, directory traversal, and outgoing
   LSP payloads are bounded and regression-tested.
3. LSP process generations now contain asynchronous stdin failures and ignore
   stale stdout/stderr events.
4. Workspace files are read through validated descriptors with before/after
   identity checks and no-follow semantics where the platform supports them.
5. A unit-tested manager registry now owns root replacement and retired-manager
   cleanup; non-clean disposal remains reachable for a real retry.
6. Malformed global or workspace configuration now fails closed with the exact
   path and actionable field or JSON diagnostics.
7. ESLint, Prettier, and focused high-risk coverage thresholds are enforced by
   `ci:verify`.
8. CI installs pinned TypeScript and Pyright servers and requires seven real
   integration tests with zero skips.
9. A native Windows acceptance job covers `.cmd`/`.bat` ownership,
   direct-process identity, idle memory reduction, and cold restart.
10. The release workflow uses tokenless npm trusted publishing and fails closed
    without a token fallback. The npm package owner must bind the documented
    repository/workflow identity in npm before publishing.
11. The required `main` ruleset is specified in
    [`docs/REPOSITORY-SETTINGS.md`](../REPOSITORY-SETTINGS.md). The available
    GitHub integration can inspect but cannot mutate branch protection or
    rulesets, so applying this repository-admin setting remains an external
    control-plane action.

## Execution Phases

### Phase 1: Correctness and security containment

- Retain non-clean suspension ownership and allow safe bounded retry.
- Stop idle actions at EOF and preserve bounded shutdown.
- Restrict executable overrides to trusted global config.
- Reject invalid MCP scan controls.

Gate: targeted lifecycle, process-ownership, config, and transport tests pass.

### Phase 2: Contract alignment

- Report the package version dynamically in MCP initialize.
- Restore `.cjs` support throughout the explicit and directory paths.
- Make `doctor` inspect the executable override runtime will use.
- Correct README links, config trust wording, supported Node versions, and
  lifecycle/release documentation.
- Commit package bin scripts with executable mode.

Gate: type-check, package verification, install smoke, and package smoke pass.

### Phase 3: CI and delivery

- Test Node 22 and 24 on Ubuntu and Windows.
- Apply least-privilege CI permissions.
- Run `npm run ci:verify` from a clean checkout.
- Inspect the final diff and confirm no unrelated generated files changed.
- Push a dedicated branch and open a pull request; do not push directly to
  `main`.

Gate: local full verification passes and GitHub CI is green.

### Phase 4: Follow-up hardening

- Implement all source-controlled P2 work.
- Require real TypeScript/Pyright integrations instead of silently skipped
  external-server tests.
- Require native Windows acceptance evidence before making quantitative
  resource-reduction claims.
- Prepare tokenless trusted publishing and document its registry-side binding.
- Specify the repository-admin ruleset that must protect `main`.

Gate: local verification, real integration tests, and the pull request's Linux
and Windows CI jobs pass.

## Completion Checklist

- [x] Exact August 28 baseline verified.
- [x] Baseline CI, local tests, package smokes, coverage, and audit captured.
- [x] P0 lifecycle and executable-trust fixes implemented.
- [x] P1 validation, metadata, `.cjs`, doctor, docs, and CI fixes implemented.
- [x] Targeted regression tests pass.
- [x] Full `npm run ci:verify` passes after final edits (209 passed, 4
      platform/toolchain skips on Linux).
- [x] Explicit TypeScript/Pyright integration verification passes (7 passed,
      zero skipped, failed, or todo).
- [x] Coverage passes globally (83.76% statements, 75.63% branches, 90.67%
      functions, 87.48% lines) and for each focused high-risk module.
- [x] `npm audit --audit-level=low` reports zero vulnerabilities.
- [x] Working tree diff is clean of unintended generated changes.
- [x] Dedicated branch is pushed and pull request opened as #9.
- [x] GitHub CI passes on Node 22 and 24 across Ubuntu and Windows.
- [x] All source-controlled P2 hardening is implemented and locally verified.
- [ ] Native Windows acceptance and pinned integration jobs pass on the final
      pull-request head.
- [ ] A repository administrator applies the documented `main` ruleset.
- [ ] The npm package owner configures the documented trusted-publisher binding.
