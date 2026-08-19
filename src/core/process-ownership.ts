import { execFileSync } from "node:child_process";
import fs from "node:fs";

export type ProcessOwnershipReasonCode =
  | "already_exited"
  | "owned_child_exit"
  | "identity_mismatch"
  | "termination_rejected"
  | "permission_denied"
  | "exit_unconfirmed"
  | "descendant_unverified";

export const defaultShutdownRequestMs = 1000;
export const defaultChildExitGraceMs = 1500;
export const defaultAggregateDisposalMs = 3000;

export interface DisposalDeadline {
  deadlineAt: number;
  shutdownRequestMs: number;
  childExitGraceMs: number;
}

export function createDisposalDeadline(
  now = Date.now(),
  aggregateMs = defaultAggregateDisposalMs,
  shutdownRequestMs = defaultShutdownRequestMs,
  childExitGraceMs = defaultChildExitGraceMs
): DisposalDeadline {
  return {
    deadlineAt: now + aggregateMs,
    shutdownRequestMs,
    childExitGraceMs
  };
}

export interface ProcessTerminationResult {
  clean: boolean;
  reasonCode: ProcessOwnershipReasonCode;
  reasonCodes?: ProcessOwnershipReasonCode[];
  failureCount?: number;
}

export function aggregateTerminationResults(
  results: Array<ProcessTerminationResult | void | undefined>,
  rejectedCount = 0
): ProcessTerminationResult | void {
  const completed = results.filter((result): result is ProcessTerminationResult => Boolean(result));
  const failures = completed.filter((result) => !result.clean);
  if (failures.length === 0 && rejectedCount === 0) return completed[0];

  const reasonCodes = [...new Set(failures.flatMap((result) => result.reasonCodes ?? [result.reasonCode]))];
  if (rejectedCount > 0) reasonCodes.push("termination_rejected");
  const distinctReasonCodes = [...new Set(reasonCodes)];
  return {
    clean: false,
    reasonCode: distinctReasonCodes[0] ?? "termination_rejected",
    ...(distinctReasonCodes.length > 1 ? { reasonCodes: distinctReasonCodes } : {}),
    failureCount: failures.length + rejectedCount
  };
}

export interface OwnedChildProcess {
  pid?: number;
  exitCode: number | null;
  signalCode?: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(eventName: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

/** An opaque OS-provided process creation identity, paired with its PID. */
export interface ProcessIdentity {
  pid: number;
  creationToken: string;
}

/**
 * Reads an identity for a PID. A missing identity is deliberately represented
 * by undefined so callers can fail closed instead of falling back to PID-only
 * termination.
 */
export interface ProcessIdentityProvider {
  read(pid: number): ProcessIdentity | undefined;
}

export interface ProcessOwnershipOptions {
  wrapper?: boolean;
  verify?: () => boolean | Promise<boolean>;
  verifyDescendants?: () => boolean | Promise<boolean>;
  identityProvider?: ProcessIdentityProvider;
}

export interface ProcessOwnership {
  terminate(deadlineAt: number): Promise<ProcessTerminationResult>;
}

export function createProcessOwnership(child: OwnedChildProcess, options: ProcessOwnershipOptions = {}): ProcessOwnership {
  let terminationPromise: Promise<ProcessTerminationResult> | undefined;
  const identityProvider = options.identityProvider ?? defaultProcessIdentityProvider;
  const launchIdentity = captureLaunchIdentity(child, identityProvider);

  return {
    terminate(deadlineAt) {
      terminationPromise ??= terminateChild(child, deadlineAt, options, identityProvider, launchIdentity);
      return terminationPromise;
    }
  };
}

export const defaultProcessIdentityProvider: ProcessIdentityProvider = {
  read: readOsProcessIdentity
};

async function terminateChild(
  child: OwnedChildProcess,
  deadlineAt: number,
  options: ProcessOwnershipOptions,
  identityProvider: ProcessIdentityProvider,
  launchIdentity: ProcessIdentity | undefined
): Promise<ProcessTerminationResult> {
  if (isExited(child)) return { clean: true, reasonCode: "already_exited" };
  if (typeof child.pid !== "number" || child.pid <= 0) {
    return { clean: false, reasonCode: "identity_mismatch" };
  }

  if (!launchIdentity || launchIdentity.pid !== child.pid) {
    return { clean: false, reasonCode: "identity_mismatch" };
  }
  // Descendant authorization is checked before any signal is sent. There is
  // intentionally no recursive kill-tree fallback for wrappers.
  if (options.wrapper) {
    try {
      if (!(await (options.verifyDescendants ?? (() => false))())) {
        return { clean: false, reasonCode: "descendant_unverified" };
      }
    } catch {
      return { clean: false, reasonCode: "descendant_unverified" };
    }
  }

  if (options.verify) {
    try {
      if (!(await options.verify())) return { clean: false, reasonCode: "identity_mismatch" };
    } catch {
      return { clean: false, reasonCode: "identity_mismatch" };
    }
  }

  // Keep this fresh read immediately adjacent to the kill. A launch-time PID
  // match alone is not sufficient because the PID may have been reused.
  let currentIdentity: ProcessIdentity | undefined;
  try {
    currentIdentity = identityProvider.read(child.pid);
  } catch {
    return { clean: false, reasonCode: "identity_mismatch" };
  }
  if (!currentIdentity || !sameProcessIdentity(launchIdentity, currentIdentity)) {
    return { clean: false, reasonCode: "identity_mismatch" };
  }

  try {
    if (!child.kill()) return { clean: false, reasonCode: "termination_rejected" };
  } catch {
    return { clean: false, reasonCode: "permission_denied" };
  }

  const exited = await waitForExit(child, deadlineAt);
  if (!exited) return { clean: false, reasonCode: "exit_unconfirmed" };
  return { clean: true, reasonCode: "owned_child_exit" };
}

function captureLaunchIdentity(
  child: OwnedChildProcess,
  identityProvider: ProcessIdentityProvider
): ProcessIdentity | undefined {
  if (typeof child.pid !== "number" || child.pid <= 0) return undefined;
  try {
    return identityProvider.read(child.pid);
  } catch {
    return undefined;
  }
}

function sameProcessIdentity(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return left.pid === right.pid && left.creationToken === right.creationToken;
}

function readOsProcessIdentity(pid: number): ProcessIdentity | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;

  try {
    if (process.platform === "win32") {
      return readWindowsProcessIdentity(pid);
    }
    if (process.platform === "linux") {
      return readLinuxProcessIdentity(pid);
    }
  } catch {
    // Access denied, a racing exit, and unsupported process metadata all fail
    // closed. No PID-only fallback is safe here.
  }
  return undefined;
}

function readLinuxProcessIdentity(pid: number): ProcessIdentity | undefined {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd === -1) return undefined;
  const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
  // The suffix starts at field 3 (state), so field 22 (starttime) is index 19.
  const startTime = fields[19];
  return startTime ? { pid, creationToken: `linux:${startTime}` } : undefined;
}

function readWindowsProcessIdentity(pid: number): ProcessIdentity | undefined {
  const command = [
    "$target = Get-CimInstance Win32_Process -Filter 'ProcessId =",
    String(pid),
    "' -ErrorAction Stop",
    "if ($null -eq $target) { exit 3 }",
    "$target.CreationDate.ToUniversalTime().Ticks"
  ].join(" ");
  const output = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 1000,
    windowsHide: true
  }).trim();
  return output ? { pid, creationToken: `windows:${output}` } : undefined;
}

function isExited(child: OwnedChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== undefined && child.signalCode !== null;
}

function waitForExit(child: OwnedChildProcess, deadlineAt: number): Promise<boolean> {
  if (isExited(child)) return Promise.resolve(true);
  const remainingMs = Math.max(0, deadlineAt - Date.now());
  if (remainingMs === 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(exited);
    };
    const timer = setTimeout(() => finish(isExited(child)), remainingMs);
    child.once("exit", () => finish(true));
  });
}
