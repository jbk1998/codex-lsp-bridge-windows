#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const receiptSchemaVersion = 1;
const r21Outcomes = new Set(["RETAIN_BASELINE", "REPEAT_MEASUREMENT", "EVALUATE_IDLE_SUSPENSION", "EVALUATE_NARROW_BROKER"]);
const supportedLanguages = new Set(["typescript", "python", "rust", "go"]);
const supportedControlStates = new Set(["negative", "positive"]);
const supportedOperationClasses = new Set(["explicit_mcp", "mcp_handshake", "diagnostics"]);

export const measurementReceiptKeys = [
  "schemaVersion",
  "runId",
  "rootFingerprint",
  "language",
  "operationClass",
  "startedAtMonotonicMs",
  "finishedAtMonotonicMs",
  "connectionDurationMs",
  "childLifetimeMs",
  "initializationDurationMs",
  "requestLatencyMs",
  "bridgePid",
  "ownedChildPid",
  "bridgeOwnedCpuMs",
  "bridgeOwnedMemoryBytes",
  "restartCount",
  "recoveryFailures",
  "controlState",
  "reasonCodes",
  "outcome"
];

export class MeasurementHarnessError extends Error {
  constructor(readonlyCode, message = readonlyCode) {
    super(message);
    this.name = "MeasurementHarnessError";
    this.code = readonlyCode;
  }
}

export async function runMeasurement(options = {}) {
  const fsImpl = options.fsImpl ?? fs;
  const clock = options.clock ?? performance;
  const randomBytesImpl = options.randomBytesImpl ?? crypto.randomBytes;
  const root = path.resolve(options.root ?? process.cwd());
  const language = options.language ?? "typescript";
  const operationClass = options.operationClass ?? "explicit_mcp";
  const controlState = options.controlState ?? "positive";
  const r21Outcome = options.r21Outcome ?? "REPEAT_MEASUREMENT";
  validateMeasurementOptions(language, operationClass, controlState, r21Outcome);

  const startedAtMonotonicMs = monotonicNow(clock);
  const runId = randomHex(randomBytesImpl, 16);
  const rootFingerprint = fingerprintRoot(root, randomBytesImpl);
  const processInspector = options.processInspector ?? createDefaultProcessInspector();
  const reasonCodes = [];
  let runDirectory;
  let bridge;
  let bridgeSampleBefore;
  let bridgeSampleAfter;
  let runMetrics = {};
  let cleanupUncertain = false;

  try {
    runDirectory = createRunDirectory(fsImpl, options.tempRoot ?? os.tmpdir());
    const cancelled = options.signal?.aborted === true;
    if (cancelled) reasonCodes.push("cancellation");

    if (cancelled) {
      // Do not start a workload after cancellation has been observed.
    } else if (controlState === "negative") {
      reasonCodes.push("negative_control_no_bridge_workload");
    } else if (options.controlObserved !== true) {
      reasonCodes.push("missing_control");
    } else if (options.controlSimultaneous !== true) {
      reasonCodes.push("non_simultaneous_control");
    } else if (options.workload === false) {
      reasonCodes.push("missing_workload");
    } else {
      const launchRecord = await resolveLaunchRecord(options);
      const validatedLaunchRecord = await revalidateLaunchRecord(launchRecord);
      const launch = options.launcher ?? launchMaterializedBridge;
      try {
        const diagnosticsTarget = operationClass === "diagnostics" ? selectDiagnosticTarget(fsImpl, root, language, options.diagnosticsFile) : undefined;
        bridge = await launch(validatedLaunchRecord, {
          root,
          language,
          operationClass,
          diagnosticsTarget,
          processInspector,
          runDirectory,
          timeoutMs: options.timeoutMs ?? 5000,
          signal: options.signal,
          clock
        });
        bridgeSampleBefore = await inspectBridge(processInspector, bridge, "launch");
        runMetrics = (await bridge.run?.()) ?? {};
        bridgeSampleAfter = await inspectBridge(processInspector, bridge, "after");
      } catch {
        throw new MeasurementHarnessError("execution_failed");
      }
    }
  } catch (error) {
    if (error instanceof MeasurementHarnessError) throw error;
    throw new MeasurementHarnessError("startup_failed");
  } finally {
    if (bridge) {
      try {
        await bridge.close?.();
        const exited = (await bridge.waitForExit?.(options.timeoutMs ?? 5000)) ?? true;
        if (!exited) {
          const identityBeforeForceClose = await inspectBridge(processInspector, bridge, "force_close");
          if (!bridgeSampleBefore?.identity || !identityBeforeForceClose || !sameIdentity(bridgeSampleBefore.identity, identityBeforeForceClose.identity)) {
            cleanupUncertain = true;
          } else {
            const forced = (await bridge.forceClose?.(bridgeSampleBefore.identity, processInspector)) ?? false;
            if (!forced) cleanupUncertain = true;
          }
          const exitedAfterForce = (await bridge.waitForExit?.(250)) ?? false;
          if (!exitedAfterForce) cleanupUncertain = true;
        }
      } catch {
        cleanupUncertain = true;
      }
    }
    if (runDirectory) {
      try {
        removeRunDirectory(fsImpl, runDirectory);
      } catch {
        cleanupUncertain = true;
      }
    }
  }

  const finishedAtMonotonicMs = monotonicNow(clock);
  if (!bridge || !Number.isInteger(bridge.pid) || bridge.pid <= 0) reasonCodes.push("ownership_ambiguous");
  if (bridge && (!bridgeSampleBefore || !bridgeSampleAfter || !sameIdentity(bridgeSampleBefore.identity, bridgeSampleAfter.identity))) {
    reasonCodes.push("pid_reuse_uncertain");
    cleanupUncertain = true;
  }

  const bridgeOwnedCpuMs = finiteOrNull(bridgeSampleAfter?.cpuMs);
  const bridgeOwnedMemoryBytes = finiteOrNull(bridgeSampleAfter?.memoryBytes);
  if (bridgeOwnedCpuMs === null || bridgeOwnedMemoryBytes === null) reasonCodes.push("metrics_unavailable");
  if (cleanupUncertain) reasonCodes.push("cleanup_uncertain");

  const ownedChild = observableOwnedChild(bridgeSampleAfter) ?? observableOwnedChild(bridgeSampleBefore);
  const ownedChildPid = ownedChild?.pid ?? null;
  if (operationClass === "diagnostics" && ownedChildPid === null) reasonCodes.push("ownership_ambiguous");
  const receipt = {
    schemaVersion: receiptSchemaVersion,
    runId,
    rootFingerprint,
    language,
    operationClass,
    startedAtMonotonicMs: roundMetric(startedAtMonotonicMs),
    finishedAtMonotonicMs: roundMetric(finishedAtMonotonicMs),
    connectionDurationMs: roundMetric(runMetrics.connectionDurationMs ?? finishedAtMonotonicMs - startedAtMonotonicMs),
    childLifetimeMs: finiteOrNull(runMetrics.childLifetimeMs),
    initializationDurationMs: finiteOrNull(runMetrics.initializationDurationMs),
    requestLatencyMs: finiteOrNull(runMetrics.requestLatencyMs),
    bridgePid: Number.isInteger(bridge?.pid) && bridge.pid > 0 ? bridge.pid : null,
    ownedChildPid,
    bridgeOwnedCpuMs,
    bridgeOwnedMemoryBytes,
    restartCount: finiteOrNull(runMetrics.restartCount ?? 0),
    recoveryFailures: finiteOrNull(runMetrics.recoveryFailures ?? 0),
    controlState,
    reasonCodes: [...new Set(reasonCodes)],
    outcome: reasonCodes.length === 0 ? r21Outcome : "INCONCLUSIVE"
  };
  validateReceipt(receipt);
  return receipt;
}

export function validateReceipt(receipt) {
  const keys = Object.keys(receipt);
  if (keys.some((key) => !measurementReceiptKeys.includes(key)) || keys.length !== measurementReceiptKeys.length) {
    throw new Error("measurement receipt contains a non-allowlisted field");
  }
  if (receipt.schemaVersion !== receiptSchemaVersion || typeof receipt.runId !== "string" || !/^[0-9a-f]{32}$/.test(receipt.runId)) {
    throw new Error("measurement receipt identity is invalid");
  }
  if (typeof receipt.rootFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(receipt.rootFingerprint)) {
    throw new Error("measurement receipt root fingerprint is invalid");
  }
  for (const key of ["startedAtMonotonicMs", "finishedAtMonotonicMs", "connectionDurationMs"]) {
    if (!Number.isFinite(receipt[key])) throw new Error(`measurement receipt timing is invalid: ${key}`);
  }
  for (const key of [
    "childLifetimeMs",
    "initializationDurationMs",
    "requestLatencyMs",
    "bridgePid",
    "ownedChildPid",
    "bridgeOwnedCpuMs",
    "bridgeOwnedMemoryBytes",
    "restartCount",
    "recoveryFailures"
  ]) {
    if (receipt[key] !== null && !Number.isFinite(receipt[key])) throw new Error(`measurement receipt metric is invalid: ${key}`);
  }
  if (!Array.isArray(receipt.reasonCodes) || receipt.reasonCodes.some((reason) => typeof reason !== "string")) {
    throw new Error("measurement receipt reason codes are invalid");
  }
  if (![...r21Outcomes, "INCONCLUSIVE"].includes(receipt.outcome)) throw new Error("measurement receipt outcome is invalid");
  return receipt;
}

export function createDefaultProcessInspector() {
  return {
    async snapshot(pid) {
      if (process.platform === "win32") return inspectWindowsProcess(pid);
      return inspectProcProcess(pid);
    }
  };
}

async function resolveLaunchRecord(options) {
  if (options.launchRecord) {
    try {
      const runtime = await importNativeNodeRuntime();
      return runtime.validateNativeNodeLaunchRecord(options.launchRecord);
    } catch {
      throw new MeasurementHarnessError("launch_record_invalid");
    }
  }
  if (options.launchRecordPath) {
    try {
      const record = JSON.parse(fs.readFileSync(path.resolve(options.launchRecordPath), "utf8"));
      const runtime = await importNativeNodeRuntime();
      return runtime.validateNativeNodeLaunchRecord(record);
    } catch {
      throw new MeasurementHarnessError("launch_record_invalid");
    }
  }

  try {
    const runtime = await importNativeNodeRuntime();
    return runtime.createNativeNodeLaunchRecord(path.join(packageRoot, "dist", "index.js"), ["mcp"]);
  } catch {
    throw new MeasurementHarnessError("launch_record_unavailable");
  }
}

async function revalidateLaunchRecord(record) {
  try {
    const runtime = await importNativeNodeRuntime();
    return runtime.validateNativeNodeLaunchRecord(record);
  } catch {
    throw new MeasurementHarnessError("launch_record_invalid");
  }
}

async function importNativeNodeRuntime() {
  return import(pathToFileURL(path.join(packageRoot, "dist", "core", "native-node-runtime.js")).href);
}

export async function launchMaterializedBridge(record, context) {
  const validatedRecord = await revalidateLaunchRecord(record);
  const child = spawn(validatedRecord.command, validatedRecord.args, {
    cwd: context.root,
    stdio: ["pipe", "pipe", "pipe"],
    windowsVerbatimArguments: false
  });
  const pendingResponses = new Map();
  let outputBuffer = "";
  let exited = false;
  let exitCode = null;
  const onData = (chunk) => {
    outputBuffer += chunk.toString("utf8");
    let newlineIndex = outputBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = outputBuffer.slice(0, newlineIndex).trim();
      outputBuffer = outputBuffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        try {
          const response = JSON.parse(line);
          const pending = pendingResponses.get(response.id);
          if (pending) {
            pendingResponses.delete(response.id);
            pending(response);
          }
        } catch {
          // Child output is deliberately not retained in the receipt.
        }
      }
      newlineIndex = outputBuffer.indexOf("\n");
    }
  };
  child.stdout.on("data", onData);
  child.stderr.resume();
  child.on("exit", (code) => {
    exited = true;
    exitCode = code;
    for (const pending of pendingResponses.values()) pending(undefined);
    pendingResponses.clear();
  });

  const request = (id, method, params) => {
    if (exited) return Promise.reject(new Error("bridge exited"));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingResponses.delete(id);
        reject(new Error("bridge response timeout"));
      }, context.timeoutMs);
      pendingResponses.set(id, (response) => {
        clearTimeout(timer);
        if (!response) reject(new Error("bridge exited before response"));
        else resolve(response);
      });
    });
  };

  return {
    pid: child.pid,
    async run() {
      const connectionStarted = monotonicNow(context.clock);
      const initializationStarted = monotonicNow(context.clock);
      await request(1, "initialize");
      const initializationDurationMs = monotonicNow(context.clock) - initializationStarted;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
      const requestStarted = monotonicNow(context.clock);
      const toolArguments = context.operationClass === "diagnostics"
        ? { file: context.diagnosticsTarget, root: context.root }
        : {};
      const toolName = context.operationClass === "diagnostics" ? "lsp_diagnostics" : "lsp_status";
      await request(2, "tools/call", { name: toolName, arguments: toolArguments });
      return {
        connectionDurationMs: monotonicNow(context.clock) - connectionStarted,
        initializationDurationMs,
        requestLatencyMs: monotonicNow(context.clock) - requestStarted,
        childLifetimeMs: null,
        restartCount: 0,
        recoveryFailures: 0,
        exitCode
      };
    },
    close() {
      if (!exited) child.stdin.end();
    },
    waitForExit(timeoutMs) {
      if (exited) return Promise.resolve(true);
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
    },
    async forceClose(expectedIdentity, inspector) {
      if (exited || !expectedIdentity || !inspector || typeof inspector.snapshot !== "function") return false;
      let current;
      try {
        current = await inspector.snapshot(child.pid, { phase: "force_close" });
      } catch {
        return false;
      }
      if (!current || current.identityObserved !== true || !sameIdentity(expectedIdentity, current.identity)) return false;
      return child.kill();
    }
  };
}

async function inspectBridge(inspector, bridge, phase) {
  const effectiveInspector = inspector ?? createDefaultProcessInspector();
  if (!Number.isInteger(bridge?.pid) || bridge.pid <= 0) return undefined;
  try {
    const sample = await effectiveInspector.snapshot(bridge.pid, { phase });
    if (!sample || sample.pid !== undefined && sample.pid !== bridge.pid || sample.identityObserved !== true || sample.identity === null || sample.identity === undefined) return undefined;
    if (sample.descendants && !Array.isArray(sample.descendants)) sample.descendants = [sample.descendants];
    return sample;
  } catch {
    return undefined;
  }
}

function observableOwnedChild(sample) {
  if (!Array.isArray(sample?.descendants)) return undefined;
  const children = sample.descendants.filter((candidate) =>
    candidate && Number.isInteger(candidate.pid) && candidate.pid > 0 && candidate.identityObserved === true && candidate.identity !== null && candidate.identity !== undefined
  );
  return children.length === 1 ? children[0] : undefined;
}

function selectDiagnosticTarget(fsImpl, root, language, requestedFile) {
  const candidates = requestedFile
    ? [requestedFile]
    : preferredDiagnosticFiles(language).map((relativePath) => path.join(root, relativePath));
  const boundedCandidates = requestedFile ? candidates : [...candidates, ...findDiagnosticCandidates(fsImpl, root, language)];
  for (const candidate of boundedCandidates) {
    const resolved = path.resolve(root, candidate);
    if (!isPathInsideRoot(root, resolved)) continue;
    try {
      const stat = fsImpl.lstatSync(resolved);
      if (stat.isFile() && !stat.isSymbolicLink() && hasLanguageExtension(resolved, language)) return resolved;
    } catch {
      // Try the next bounded, deterministic candidate.
    }
  }
  throw new MeasurementHarnessError("diagnostic_target_unavailable");
}

function findDiagnosticCandidates(fsImpl, root, language) {
  const results = [];
  const pending = [{ directory: root, depth: 0 }];
  const ignoredDirectories = new Set([".git", "node_modules", "dist", "coverage"]);
  while (pending.length > 0 && results.length < 32) {
    const current = pending.shift();
    let entries;
    try {
      entries = fsImpl.readdirSync(current.directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = path.join(current.directory, entry.name);
      if (entry.isFile() && hasLanguageExtension(candidate, language)) results.push(candidate);
      else if (entry.isDirectory() && current.depth < 3 && !ignoredDirectories.has(entry.name)) pending.push({ directory: candidate, depth: current.depth + 1 });
      if (results.length >= 32) break;
    }
  }
  return results;
}

function preferredDiagnosticFiles(language) {
  if (language === "typescript") return ["src/index.ts", "src/index.tsx", "index.ts", "index.tsx"];
  if (language === "python") return ["src/main.py", "main.py"];
  if (language === "rust") return ["src/main.rs", "src/lib.rs", "main.rs", "lib.rs"];
  return ["main.go", "src/main.go"];
}

function hasLanguageExtension(filePath, language) {
  const extension = path.extname(filePath).toLowerCase();
  if (language === "typescript") return [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(extension);
  return extension === ({ python: ".py", rust: ".rs", go: ".go" }[language] ?? "");
}

function isPathInsideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function inspectWindowsProcess(pid) {
  const script = "$p = Get-Process -Id " + pid + " -ErrorAction Stop; $all = @(); try { $all = @(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,CreationDate) } catch {}; $desc = @(); $frontier = @( " + pid + "); while ($frontier.Count -gt 0) { $next = @(); foreach ($item in $all) { if ($frontier -contains [int]$item.ParentProcessId) { $desc += [pscustomobject]@{ pid = [int]$item.ProcessId; identity = \"$($item.ProcessId):$($item.CreationDate)\"; identityObserved = $true }; $next += [int]$item.ProcessId } } $frontier = $next }; [pscustomobject]@{ pid = [int]$p.Id; identity = \"$($p.Id):$($p.StartTime.ToUniversalTime().Ticks)\"; identityObserved = $true; alive = $true; cpuMs = [double]$p.TotalProcessorTime.TotalMilliseconds; memoryBytes = [int64]$p.WorkingSet64; descendants = @($desc) } | ConvertTo-Json -Compress";
  return runProcessInspector("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
}

async function runProcessInspector(command, args) {
  const { stdout } = await execFileAsync(command, args, { windowsHide: true, maxBuffer: 256 * 1024 });
  const sample = JSON.parse(stdout);
  if (Array.isArray(sample)) throw new Error("unexpected process inspector response");
  return sample;
}

async function inspectProcProcess(pid) {
  if (!isProcessAlive(pid)) throw new Error("process is not alive");
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const startTime = fields[19];
  const cpuTicks = Number(fields[11]) + Number(fields[12]);
  const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
  const memoryMatch = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
  return {
    pid,
    identity: `${pid}:${startTime}`,
    identityObserved: true,
    alive: true,
    cpuMs: Number.isFinite(cpuTicks) ? cpuTicks * 10 : null,
    memoryBytes: memoryMatch ? Number(memoryMatch[1]) * 1024 : null,
    descendants: []
  };
}

function createRunDirectory(fsImpl, tempRoot) {
  const resolvedTempRoot = path.resolve(tempRoot);
  const runDirectory = fsImpl.mkdtempSync(path.join(resolvedTempRoot, "codex-lsp-measure-"));
  const stat = fsImpl.lstatSync(runDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new MeasurementHarnessError("run_directory_invalid");
  return runDirectory;
}

function removeRunDirectory(fsImpl, runDirectory) {
  const stat = fsImpl.lstatSync(runDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("run directory was replaced");
  fsImpl.rmSync(runDirectory, { recursive: true, force: true });
}

function validateMeasurementOptions(language, operationClass, controlState, r21Outcome) {
  if (!supportedLanguages.has(language)) throw new MeasurementHarnessError("invalid_language");
  if (!supportedOperationClasses.has(operationClass)) throw new MeasurementHarnessError("invalid_operation_class");
  if (!supportedControlStates.has(controlState)) throw new MeasurementHarnessError("invalid_control_state");
  if (!r21Outcomes.has(r21Outcome)) throw new MeasurementHarnessError("invalid_r21_outcome");
}

function fingerprintRoot(root, randomBytesImpl) {
  const salt = randomBytesImpl(32);
  return crypto.createHash("sha256").update(salt).update(root).digest("hex");
}

function randomHex(randomBytesImpl, size) {
  return randomBytesImpl(size).toString("hex");
}

function sameIdentity(left, right) {
  return left !== null && left !== undefined && (left === right || typeof left === "string" && left === right || typeof left === "number" && left === right);
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function roundMetric(value) {
  return Math.max(0, Math.round(value * 100) / 100);
}

function monotonicNow(clock) {
  return typeof clock.now === "function" ? clock.now() : performance.now();
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const receipt = await runMeasurement(args);
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch (error) {
    const code = error instanceof MeasurementHarnessError ? error.code : "execution_failed";
    process.stderr.write(`[codex-lsp-bridge] HARNESS_ERROR: ${code}\n`);
    process.exitCode = 1;
  }
}

function parseArgs(args) {
  const values = {
    root: process.cwd(),
    language: "typescript",
    operationClass: "explicit_mcp",
    controlState: "positive",
    r21Outcome: "REPEAT_MEASUREMENT",
    controlObserved: false,
    controlSimultaneous: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--control-observed") values.controlObserved = true;
    else if (arg === "--control-simultaneous") values.controlSimultaneous = true;
    else if (arg.startsWith("--")) {
      const key = {
        "--root": "root",
        "--language": "language",
        "--operation": "operationClass",
        "--control": "controlState",
        "--r21-outcome": "r21Outcome",
        "--record": "launchRecordPath",
        "--timeout-ms": "timeoutMs"
      }[arg];
      if (!key || index + 1 >= args.length) throw new MeasurementHarnessError("invalid_arguments");
      values[key] = args[++index];
    } else {
      throw new MeasurementHarnessError("invalid_arguments");
    }
  }
  return values;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
