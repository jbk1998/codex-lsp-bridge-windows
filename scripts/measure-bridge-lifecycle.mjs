#!/usr/bin/env node
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
      const launch = options.launcher ?? launchMaterializedBridge;
      try {
        bridge = await launch(launchRecord, {
          root,
          language,
          operationClass,
          runDirectory,
          timeoutMs: options.timeoutMs ?? 5000,
          signal: options.signal,
          clock
        });
        bridgeSampleBefore = await inspectBridge(options.processInspector, bridge, "before");
        runMetrics = (await bridge.run?.()) ?? {};
        bridgeSampleAfter = await inspectBridge(options.processInspector, bridge, "after");
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
          await bridge.forceClose?.();
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
  if (!bridgeSampleBefore || !bridgeSampleAfter || !sameIdentity(bridgeSampleBefore.identity, bridgeSampleAfter.identity)) {
    reasonCodes.push("pid_reuse_uncertain");
  }

  const bridgeOwnedCpuMs = finiteOrNull(bridgeSampleAfter?.cpuMs ?? runMetrics.bridgeOwnedCpuMs);
  const bridgeOwnedMemoryBytes = finiteOrNull(bridgeSampleAfter?.memoryBytes ?? runMetrics.bridgeOwnedMemoryBytes);
  if (bridgeOwnedCpuMs === null || bridgeOwnedMemoryBytes === null) reasonCodes.push("metrics_unavailable");
  if (cleanupUncertain) reasonCodes.push("cleanup_uncertain");

  const ownedChildPid = Number.isInteger(bridge?.ownedChildPid) && bridge.ownedChildIdentityProven === true ? bridge.ownedChildPid : null;
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
    async snapshot(pid, context = {}) {
      return {
        pid,
        identity: context.handle?.ownershipToken ?? null,
        ownershipProven: context.handle?.ownershipToken !== undefined,
        alive: isProcessAlive(pid),
        cpuMs: null,
        memoryBytes: null
      };
    }
  };
}

async function resolveLaunchRecord(options) {
  if (options.launchRecord) return options.launchRecord;
  if (options.launchRecordPath) {
    try {
      const record = JSON.parse(fs.readFileSync(path.resolve(options.launchRecordPath), "utf8"));
      const runtime = await import(pathToFileURL(path.join(packageRoot, "dist", "core", "native-node-runtime.js")).href);
      return runtime.validateNativeNodeLaunchRecord(record);
    } catch {
      throw new MeasurementHarnessError("launch_record_invalid");
    }
  }

  try {
    const runtime = await import(pathToFileURL(path.join(packageRoot, "dist", "core", "native-node-runtime.js")).href);
    return runtime.createNativeNodeLaunchRecord(path.join(packageRoot, "dist", "index.js"), ["mcp"]);
  } catch {
    throw new MeasurementHarnessError("launch_record_unavailable");
  }
}

async function launchMaterializedBridge(record, context) {
  const child = spawn(record.command, record.args, {
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
    ownershipToken: child,
    async run() {
      const connectionStarted = monotonicNow(context.clock);
      const initializationStarted = monotonicNow(context.clock);
      await request(1, "initialize");
      const initializationDurationMs = monotonicNow(context.clock) - initializationStarted;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
      const requestStarted = monotonicNow(context.clock);
      await request(2, "tools/call", { name: "lsp_status", arguments: {} });
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
    forceClose() {
      if (!exited) child.kill();
    }
  };
}

async function inspectBridge(inspector, bridge, phase) {
  const effectiveInspector = inspector ?? createDefaultProcessInspector();
  if (!Number.isInteger(bridge?.pid) || bridge.pid <= 0) return undefined;
  try {
    const sample = await effectiveInspector.snapshot(bridge.pid, { phase, handle: bridge });
    if (!sample || sample.ownershipProven !== true) return undefined;
    return sample;
  } catch {
    return undefined;
  }
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
