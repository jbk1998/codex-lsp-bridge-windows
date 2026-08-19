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
  separate MCP connections.

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
- Shutdown stops new work, disposes bridge-owned state, and confirms within a
  bounded timeout that no bridge-owned child remains. A timeout is a visible
  failure, not silent success.
- On Windows, a language-server `.cmd` or `.bat` wrapper is not treated as an
  owned process group from a parent-PID snapshot. Without a handle-backed or
  Job Object boundary, wrapper teardown fails closed with a non-clean result;
  the bridge never recursively kills an unproven descendant tree.
- Idle suspension, a persistent broker, cross-connection reuse, and shared
  persistent state remain deferred until measurement justifies a separate
  scope decision.

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
3. Evaluate conditional idle suspension if material idle LSP memory is proven.
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
