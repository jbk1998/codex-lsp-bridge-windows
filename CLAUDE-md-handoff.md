# Handoff: CLAUDE.md setup for codex-lsp-bridge-windows

## Objective

Continue from the project folder with full context for the new project-level `CLAUDE.md`. The next session should review, optionally refine, and decide whether to commit/push `CLAUDE.md` and any related instruction files.

## Current State

- Repo path: `C:\Users\JackKenter\ClaudeWorkspace\codex-lsp-bridge-windows`
- Branch: `main`
- HEAD: `ecb2963`
- Remote: `https://github.com/jbk1998/codex-lsp-bridge-windows`
- Open PRs: none reported by `gh pr list --repo jbk1998/codex-lsp-bridge-windows --state open`
- Worktree: single worktree at `C:/Users/JackKenter/ClaudeWorkspace/codex-lsp-bridge-windows`

Dirty/untracked files:

- `CLAUDE.md` is newly created for this task and is the main artifact.
- `AGENTS.md` is also untracked and currently contains the same content as `CLAUDE.md`; it appears to have been generated or present outside the explicit `CLAUDE.md` edit. Do not delete it without confirming whether the user wants both Codex and Claude instruction files committed.
- `.codex/config.toml` is untracked and was not created by the `CLAUDE.md` edit. Treat it as unrelated unless the user asks to configure local Codex project settings.
- `CLAUDE-md-handoff.md` is this handoff file.

Recent commits:

- `ecb2963 ci: test Node 22 and 24`
- `7e79160 fix CI coverage threshold`
- `1ef4e35 fix CI and update vitest`
- `0779db8 fix Windows LSP diagnostics for Codex`
- `f3272c8 fix: mark timed out diagnostics inconclusive`

## What Was Done

- Used the requested Claude skill:
  `C:\Users\JackKenter\.claude\plugins\cache\claude-plugins-official\claude-md-management\1.0.0\skills\claude-md-improver\SKILL.md`
- Confirmed there was no existing `CLAUDE.md` in the repo before creation.
- Inspected `package.json`, `README.md`, `CONTRIBUTING.md`, `.github/workflows/ci.yml`, `scripts/install-codex.mjs`, `scripts/codex-lsp-post-tool-use.mjs`, `src/`, and `tests/`.
- Created root `CLAUDE.md` with:
  - project purpose and commands
  - CI matrix notes
  - architecture and key files
  - supported language-server mappings
  - read-only/project constraints
  - Windows `.cmd` shim and path gotchas
  - targeted test commands
  - public repo and release notes
- Verified by reading `CLAUDE.md` back and checking `git status`.

## Key Decisions

- `CLAUDE.md` is intentionally concise and project-specific. It avoids generic Claude usage advice.
- The file emphasizes the read-only posture, honest diagnostics status, and root boundary safety because these are the main project invariants.
- The file documents PowerShell as the local shell default because this is a Windows project environment.
- The file keeps TypeScript/JavaScript as the primary support path and marks Python, Rust, and Go as experimental, matching current docs.
- The package identity remains `codex-lsp-bridge`; the public repo is `jbk1998/codex-lsp-bridge-windows`. The next agent should not rename package metadata casually.

## Remaining Work

1. Review `CLAUDE.md` in the project root:

   ```powershell
   Get-Content CLAUDE.md
   ```

2. Decide whether to keep and commit both instruction files:

   - `CLAUDE.md` for Claude Code.
   - `AGENTS.md` for Codex and other agents.

3. Decide whether `.codex/config.toml` belongs in this repo. Inspect first:

   ```powershell
   Get-Content .codex\config.toml
   ```

4. If committing only the Claude instruction file and this handoff is not meant to be permanent, stage narrowly:

   ```powershell
   git add CLAUDE.md
   git commit -m "docs: add Claude project instructions"
   git push origin main
   ```

5. If the user wants both Claude and Codex instructions committed, review `AGENTS.md` first and then stage both intentionally:

   ```powershell
   git add CLAUDE.md AGENTS.md
   git commit -m "docs: add project agent instructions"
   git push origin main
   ```

6. If the handoff file should not remain in the repo, delete it after the next agent has consumed it.

## Verification Status

Completed in this session before the handoff:

- `npm run ci:verify` passed locally after the CI Node matrix change.
- GitHub Actions run `27045386233` passed all six CI jobs:
  - Ubuntu Node 22 and 24
  - macOS Node 22 and 24
  - Windows Node 22 and 24
- `CLAUDE.md` was read back after creation.
- `git status --short --branch` showed untracked `CLAUDE.md`, `AGENTS.md`, and `.codex/` before this handoff file was added.

Not run after adding `CLAUDE.md`:

- No test run was needed for the documentation-only `CLAUDE.md` addition.
- No commit or push was made for `CLAUDE.md`.

## Risks and Open Questions

- `AGENTS.md` is untracked and duplicates the new `CLAUDE.md`; clarify whether the user wants both files committed.
- `.codex/config.toml` is untracked and unrelated to the `CLAUDE.md` task; do not stage it accidentally.
- The GitHub contributors page for the repo may still show `WEED-Jeonseonghun` due to an immutable hidden closed Dependabot PR ref. Main, tags, and normal branches were verified clean earlier, but this stale GitHub contributor display was intentionally left as-is after the user said it was fine.

## Suggested Skills

- `claude-md-improver`: Use if refining or auditing `CLAUDE.md` further.
- `handoff`: Use if creating a final continuation note after deciding what to commit.
