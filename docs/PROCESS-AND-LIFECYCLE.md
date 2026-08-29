# Process and Lifecycle Contract

This document is the concise operational reference for the staged LSP bridge
process-reuse work. The full debate, requirements, and acceptance examples are
in [the 2026-08-18 plan](./2026-08-18-lsp-bridge-process-reuse-debate-and-plan.md).

## Status

The source implementation, generated no-hook baseline, and repository-local
measurement boundary are in place. Native Windows process-identity, resource,
fresh-install, and simultaneous-control evidence remains an acceptance gate;
repository fixtures do not establish production load improvement.

## User-facing behavior

- Explicit MCP LSP tools remain available when automatic `PostToolUse`
  diagnostics are disabled.
- Codex users do not select, attach to, or manage bridge or language-server
  processes.
- The bridge reports unavailable, stale, timed-out, or ambiguous results as
  such. None of these states is a clean type-check result.
- The bridge keeps state within a live MCP process: one manager per workspace
  root and one provider per language. The contract does not promise reuse across
  separate MCP connections. A configured idle timeout suspends bridge-owned
  language-server resources while leaving the MCP connection open.

## Workspace identity and selection

- An explicit `root` is canonicalized and must be an existing directory. A
  recognized workspace marker is useful project metadata, but it is not
  required when the caller names the exact directory. The manager key is the
  canonical real path, normalized for the host.
- When `root` is omitted and a request names an absolute file, directory, or
  file URI, the bridge walks upward from that target and selects the nearest
  marker. This lets a skill folder with `SKILL.md` remain separate from a
  broader parent that also contains `package.json`. If no marker exists, the
  target's existing containing directory becomes the root. This keeps
  markerless folders usable without broadening the root to a drive or home
  directory.
- A manager also records the directory-instance identity. If a workspace is
  deleted and recreated at the same path, the old manager and provider are not
  reused. The old language-server child is retired and the new root gets fresh
  state.
- Documents, diagnostic revisions, waiters, clients, and recovery generations
  belong to one manager and one language provider. They are never shared by
  path alone across distinct roots.

## Runtime launch rules

- The bridge runtime uses an approved native `node.exe` directly. Generated MCP,
  updater, and hook launch commands must resolve that executable rather than a
  bare `node`, `node.cmd`, another command shim, or `node_repl.exe`.
- The runtime rule applies to the bridge's own launcher. A configured language
  server may still use a supported `.cmd` or `.bat` wrapper when that server
  requires it.
- `node_repl.exe` is Codex Code Mode infrastructure, not the bridge runtime.
  Its process load must not be attributed to the bridge.
- If the native launcher is missing, stale, or not executable, the Codex
  launcher or configuration-validation path must provide an actionable error.

## Lifecycle rules

- Language servers start lazily and are reused safely for repeated requests in
  the same live MCP process.
- Concurrent first requests for one root and language settle on one manager,
  one provider, and one steady-state language-server child.
- Provider recovery reinitializes the service and reopens documents required by
  the current request before returning a dependent result.
- A file-diagnostics timeout is one end-to-end deadline measured from request
  entry. It covers initialization, recovery, root and file resolution,
  document open or change, and the stable `publishDiagnostics` wait. A timeout
  returns `status: timed_out`, `timedOut: true`, and `stale: true`.
- A timed-out waiter is removed and its timers are cleared. The language server
  may continue a healthy in-flight startup, but an old generation, old root,
  or already-committed source revision cannot publish into a later result.
  A subsequent request can use a completed recovery or receive an explicit
  unavailable result if recovery failed.
- Failed writes, including asynchronous stdin `EPIPE` events, process exits, and
  shutdown reject and clear outstanding JSON-RPC requests for the matching
  process generation. Shutdown is shared and bounded, so repeated close or
  root-switch paths do not create duplicate child teardown or orphaned request
  state.
- Shutdown stops new work, disposes bridge-owned state, and confirms within a
  bounded timeout that no bridge-owned child remains. A timeout is a visible
  failure, not silent success.
- The MCP stdio transport accepts `mcpIdleTimeoutMs` from the global or
  workspace `lsp-client.json`. It resets on each non-empty incoming message,
  defaults to disabled when omitted, and defers suspension until active requests
  settle. A value of `0` disables the timeout. The MCP process remains open and
  the next request rehydrates providers lazily. The startup root supplies the
  timer for the connection; later root selection does not replace it.
- MCP newline-delimited input is capped at 1 MiB and 64 active request handlers.
  LSP content is capped at 16 MiB in both directions. Workspace source is read
  through a descriptor whose root, canonical path, and identity are revalidated
  before and after the read.
- On Windows, a language-server `.cmd` or `.bat` wrapper is not treated as an
  owned process group from a parent-PID snapshot. Without a handle-backed or
  Job Object boundary, wrapper teardown fails closed with a non-clean result;
  the bridge never recursively kills an unproven descendant tree.
- A persistent broker, cross-connection reuse, and shared persistent state
  remain deferred until measurement justifies a separate scope decision.

## Measurement rules

Baseline measurement is opt-in and local. Run
`scripts/measure-bridge-lifecycle.mjs` only during an approved measurement
window with the approved native Node executable. The harness is repository-only,
inactive outside measurement runs, creates no resident service or persistent
shared state, and records only allowlisted process and lifecycle metrics. It
must not capture source contents, document text, credentials, or unrelated
process data.

The baseline includes:

- a representative explicit-LSP workload with automatic diagnostics disabled;
- a negative attribution control with Code Mode activity and no bridge activity;
- a positive attribution control with bridge activity and `node_repl.exe`
  activity at the same time;
- bridge launches, connection duration, child lifetime, cold-start and request
  latency, CPU, memory, restarts, and recovery failures.

If process ownership or workload representativeness cannot be established, the
run emits one `INCONCLUSIVE` receipt. Startup, parse, or execution failure is a
`HARNESS_ERROR` with no receipt. An inconclusive run must be repeated or
extended, and neither result can support a bridge-load or machine-load
improvement claim.

The four permitted baseline outcomes are:

1. Retain the baseline.
2. Repeat or extend measurement because evidence is inconclusive.
3. Measure idle suspension's memory reduction and cold-start tradeoff after it is
   enabled.
4. Evaluate a narrow broker only if frequent MCP reconnections and costly cold
   starts remain after the baseline.

Automatic diagnostics remain disabled throughout the baseline. Any future hook
reactivation proposal must demonstrate user benefit and reduce one edit event to
at most one bridge CLI invocation.

## Acceptance checklist

Before calling the staged rollout complete, verify:

- direct native runtime launch in local, generated, updater, plugin, and hook
  configurations;
- explicit diagnostics with automatic diagnostics disabled;
- supported language-server `.cmd` and `.bat` compatibility;
- root and language reuse, isolation, recovery, concurrency, and bounded clean
  shutdown;
- negative and positive process-attribution controls;
- privacy, rollback, and `INCONCLUSIVE` handling;
- no load-improvement claim without representative workload and valid
  attribution.

The default installer leaves the managed hook absent or disabled. The historical
per-file wrapper and batching/IPC helper are characterized separately and are
not current baseline acceptance evidence. A future hook proposal must count
total bridge invocations across all files and languages in one edit event and
must prove no more than one.

See [RELEASE.md](./RELEASE.md) for the release gate and
[CONTRIBUTING.md](../CONTRIBUTING.md) for contributor expectations.
