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
}

export interface OwnedChildProcess {
  pid?: number;
  exitCode: number | null;
  signalCode?: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(eventName: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export interface ProcessOwnershipOptions {
  wrapper?: boolean;
  verify?: () => boolean | Promise<boolean>;
  verifyDescendants?: () => boolean | Promise<boolean>;
}

export interface ProcessOwnership {
  terminate(deadlineAt: number): Promise<ProcessTerminationResult>;
}

export function createProcessOwnership(child: OwnedChildProcess, options: ProcessOwnershipOptions = {}): ProcessOwnership {
  let terminationPromise: Promise<ProcessTerminationResult> | undefined;
  const verify = options.verify ?? (() => true);

  return {
    terminate(deadlineAt) {
      terminationPromise ??= terminateChild(child, deadlineAt, options, verify);
      return terminationPromise;
    }
  };
}

async function terminateChild(
  child: OwnedChildProcess,
  deadlineAt: number,
  options: ProcessOwnershipOptions,
  verify: () => boolean | Promise<boolean>
): Promise<ProcessTerminationResult> {
  if (isExited(child)) return { clean: true, reasonCode: "already_exited" };
  if (typeof child.pid !== "number" || child.pid <= 0) {
    return { clean: false, reasonCode: "identity_mismatch" };
  }
  if (!(await verify())) return { clean: false, reasonCode: "identity_mismatch" };

  try {
    if (!child.kill()) return { clean: false, reasonCode: "termination_rejected" };
  } catch {
    return { clean: false, reasonCode: "permission_denied" };
  }

  const exited = await waitForExit(child, deadlineAt);
  if (!exited) return { clean: false, reasonCode: "exit_unconfirmed" };
  if (options.wrapper && !(await (options.verifyDescendants ?? (() => false))())) {
    return { clean: false, reasonCode: "descendant_unverified" };
  }
  return { clean: true, reasonCode: "owned_child_exit" };
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
