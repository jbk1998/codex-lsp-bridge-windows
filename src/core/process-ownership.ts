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
  verifyDescendants?: (pid: number) => boolean | Promise<boolean>;
  descendantProvider?: ProcessDescendantProvider;
  identityProvider?: ProcessIdentityProvider;
}

export interface ProcessDescendantProvider {
  list(pid: number): number[] | undefined;
}

export interface ProcessOwnership {
  terminate(deadlineAt: number): Promise<ProcessTerminationResult>;
}

export function createProcessOwnership(child: OwnedChildProcess, options: ProcessOwnershipOptions = {}): ProcessOwnership {
  let terminationPromise: Promise<ProcessTerminationResult> | undefined;
  const identityProvider = options.identityProvider ?? defaultProcessIdentityProvider;
  // Windows shell wrappers are never eligible for generic child.kill(). Do
  // not spend a synchronous process-query timeout capturing an identity that
  // cannot authorize termination; terminateChild reports the stronger
  // descendant boundary below before consulting it.
  const launchIdentity = options.wrapper && process.platform === "win32" ? undefined : captureLaunchIdentity(child, identityProvider);

  return {
    terminate(deadlineAt) {
      if (!terminationPromise) {
        const attempt = terminateChild(child, deadlineAt, options, identityProvider, launchIdentity);
        const trackedAttempt = attempt.then(
          (result) => {
            if (!result.clean && terminationPromise === trackedAttempt) terminationPromise = undefined;
            return result;
          },
          (error) => {
            if (terminationPromise === trackedAttempt) terminationPromise = undefined;
            throw error;
          }
        );
        terminationPromise = trackedAttempt;
      }
      return terminationPromise;
    }
  };
}

export const defaultProcessIdentityProvider: ProcessIdentityProvider = {
  read: readOsProcessIdentity
};

export const defaultProcessDescendantProvider: ProcessDescendantProvider = {
  list: readOsProcessDescendants
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

  // A .cmd/.bat process is a shell boundary rather than an owned process
  // group. Refuse it before identity probing so a slow/unavailable native
  // process query cannot mask the reason for the refusal.
  if (options.wrapper && process.platform === "win32") {
    return { clean: false, reasonCode: "descendant_unverified" };
  }

  if (!launchIdentity || launchIdentity.pid !== child.pid) {
    return { clean: false, reasonCode: "identity_mismatch" };
  }
  // Descendant authorization is checked before any signal is sent. There is
  // intentionally no recursive kill-tree fallback for wrappers. On Windows a
  // .cmd/.bat wrapper is not an owned process group, even when a point-in-time
  // descendant snapshot happens to be empty. Refuse generic child.kill() for
  // that boundary until a handle-backed or Job Object terminator is available.
  if (options.wrapper) {
    if (process.platform === "win32") {
      return { clean: false, reasonCode: "descendant_unverified" };
    }
    try {
      const verifyDescendants = options.verifyDescendants ?? ((pid: number) => verifyNoDescendants(pid, options.descendantProvider));
      if (!(await verifyDescendants(child.pid))) {
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
    if (isExited(child)) return { clean: true, reasonCode: "already_exited" };
    return { clean: false, reasonCode: "identity_mismatch" };
  }
  if (!currentIdentity || !sameProcessIdentity(launchIdentity, currentIdentity)) {
    if (isExited(child)) return { clean: true, reasonCode: "already_exited" };
    return { clean: false, reasonCode: "identity_mismatch" };
  }

  if (isExited(child)) return { clean: true, reasonCode: "already_exited" };

  try {
    if (!child.kill()) {
      if (isExited(child)) return { clean: true, reasonCode: "already_exited" };
      return { clean: false, reasonCode: "termination_rejected" };
    }
  } catch {
    if (isExited(child)) return { clean: true, reasonCode: "already_exited" };
    return { clean: false, reasonCode: "permission_denied" };
  }

  const exited = await waitForExit(child, deadlineAt);
  if (!exited) return { clean: false, reasonCode: "exit_unconfirmed" };
  return { clean: true, reasonCode: "owned_child_exit" };
}

function captureLaunchIdentity(child: OwnedChildProcess, identityProvider: ProcessIdentityProvider): ProcessIdentity | undefined {
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
  const fields = stat
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/);
  // The suffix starts at field 3 (state), so field 22 (starttime) is index 19.
  const startTime = fields[19];
  return startTime ? { pid, creationToken: `linux:${startTime}` } : undefined;
}

export function buildWindowsProcessIdentityCommand(pid: number): string {
  // The owned child runs as the current user, so Get-Process can read its
  // immutable creation time without paying the multi-second cold-start cost
  // of the CIM provider during a bounded shutdown.
  return [
    `$target = Get-Process -Id ${String(pid)} -ErrorAction Stop`,
    "[Console]::Out.Write($target.StartTime.ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture))"
  ].join("; ");
}

function readWindowsProcessIdentity(pid: number): ProcessIdentity | undefined {
  const command = buildWindowsProcessIdentityCommand(pid);
  const output = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    // A cold Windows PowerShell startup exceeded one second on hosted CI.
    // Three seconds remains bounded while avoiding false identity failures.
    timeout: 3000,
    windowsHide: true
  }).trim();
  const normalizedOutput = output.replace(/^\uFEFF/, "").trim();
  return normalizedOutput ? { pid, creationToken: `windows:${normalizedOutput}` } : undefined;
}

function verifyNoDescendants(pid: number, provider = defaultProcessDescendantProvider): boolean {
  const descendants = provider.list(pid);
  return descendants !== undefined && descendants.length === 0;
}

function readOsProcessDescendants(pid: number): number[] | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    if (process.platform === "win32") return readWindowsProcessDescendants(pid);
    if (process.platform === "linux") return readLinuxProcessDescendants(pid);
  } catch {
    // Process enumeration is an authorization check. Access errors fail closed.
  }
  return undefined;
}

function readLinuxProcessDescendants(rootPid: number): number[] | undefined {
  const parentByPid = new Map<number, number>();
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      if (commandEnd === -1) continue;
      const fields = stat
        .slice(commandEnd + 1)
        .trim()
        .split(/\s+/);
      const parentPid = Number(fields[1]);
      if (Number.isSafeInteger(parentPid) && parentPid > 0) parentByPid.set(pid, parentPid);
    } catch {
      // A process can disappear between directory enumeration and stat read.
    }
  }
  if (!parentByPid.has(rootPid) && rootPid !== process.pid) return undefined;
  const descendants: number[] = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const parentPid = queue.shift()!;
    for (const [candidatePid, candidateParentPid] of parentByPid) {
      if (candidateParentPid !== parentPid || candidatePid === rootPid || descendants.includes(candidatePid)) continue;
      descendants.push(candidatePid);
      queue.push(candidatePid);
    }
  }
  return descendants;
}

function readWindowsProcessDescendants(rootPid: number): number[] | undefined {
  const command = [
    "$root =",
    String(rootPid),
    "; $all = @(Get-CimInstance Win32_Process -ErrorAction Stop); $known = @($root); $changed = $true;",
    "while ($changed) { $changed = $false; foreach ($item in $all) { $itemPid = [int]$item.ProcessId; $parentPid = [int]$item.ParentProcessId; if (($known -contains $parentPid) -and -not ($known -contains $itemPid)) { $known += $itemPid; $changed = $true } } }",
    "$known | Where-Object { $_ -ne $root } | ConvertTo-Json -Compress"
  ].join(" ");
  const output = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 1500,
    windowsHide: true
  }).trim();
  if (!output || output === "null") return [];
  const parsed = JSON.parse(output);
  const values = Array.isArray(parsed) ? parsed : [parsed];
  return values.filter((value) => Number.isSafeInteger(Number(value)) && Number(value) > 0).map(Number);
}

function isExited(child: OwnedChildProcess): boolean {
  return child.exitCode !== null || (child.signalCode !== undefined && child.signalCode !== null);
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
