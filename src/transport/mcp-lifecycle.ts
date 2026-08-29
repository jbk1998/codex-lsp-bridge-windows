import {
  createDisposalDeadline,
  type DisposalDeadline,
  type ProcessTerminationResult,
  type ProcessOwnershipReasonCode
} from "../core/process-ownership.js";

export type McpLifecycleState = "open" | "closing" | "draining" | "clean" | "non_clean";

export type McpLifecycleReasonCode =
  ProcessOwnershipReasonCode | "active_requests_timeout" | "disposal_failed" | "disposal_timeout" | "transport_failed";

export interface McpLifecycleResult {
  state: "clean" | "non_clean";
  clean: boolean;
  activeRequestCount: number;
  reasonCode?: McpLifecycleReasonCode;
  reasonCodes?: McpLifecycleReasonCode[];
  cleanupPending?: boolean;
}

export interface McpLifecycleOptions {
  dispose?: (deadline: DisposalDeadline) => Promise<ProcessTerminationResult | void>;
  createDeadline?: () => DisposalDeadline;
}

/**
 * Owns one MCP stdio connection's request and disposal boundary.
 *
 * The coordinator deliberately has no persistence or cancellation API. Work
 * that has started remains tracked until it settles; EOF starts one bounded
 * disposal sequence, while a transport idle timeout may suspend LSP resources
 * without closing the MCP connection.
 */
export class McpLifecycleCoordinator {
  private readonly activeRequests = new Set<Promise<unknown>>();
  private closePromise: Promise<McpLifecycleResult> | undefined;
  private lifecycleState: McpLifecycleState = "open";
  private pendingDisposal: Promise<ProcessTerminationResult | void> | undefined;

  constructor(private readonly options: McpLifecycleOptions = {}) {}

  get state(): McpLifecycleState {
    return this.lifecycleState;
  }

  get activeRequestCount(): number {
    return this.activeRequests.size;
  }

  dispatch<T>(work: () => Promise<T> | T): Promise<T> {
    if (this.lifecycleState !== "open") {
      return Promise.reject(new Error("MCP connection is closing"));
    }

    const task = Promise.resolve().then(work);
    this.activeRequests.add(task);
    void task.then(
      () => this.activeRequests.delete(task),
      () => this.activeRequests.delete(task)
    );
    return task;
  }

  close(deadline = this.options.createDeadline?.() ?? createDisposalDeadline()): Promise<McpLifecycleResult> {
    if (this.closePromise) return this.closePromise;
    this.lifecycleState = "closing";
    this.closePromise = this.closeInternal(deadline);
    return this.closePromise;
  }

  private async closeInternal(deadline: DisposalDeadline): Promise<McpLifecycleResult> {
    this.lifecycleState = "draining";
    const drained = await this.waitForActiveRequests(deadline.deadlineAt);
    let termination: ProcessTerminationResult | void = undefined;
    let disposalFailed = false;
    let disposalTimedOut = false;

    try {
      const disposalPromise = Promise.resolve(this.options.dispose?.(deadline) ?? undefined);
      this.pendingDisposal = disposalPromise;
      const outcome = await observeDisposal(disposalPromise, deadline.deadlineAt);
      if (outcome.kind === "timeout") disposalTimedOut = true;
      else if (outcome.kind === "rejected") disposalFailed = true;
      else termination = outcome.value;
      if (outcome.kind !== "timeout") this.pendingDisposal = undefined;
      else {
        void disposalPromise.then(
          () => this.clearPendingDisposal(disposalPromise),
          () => this.clearPendingDisposal(disposalPromise)
        );
      }
    } catch {
      this.pendingDisposal = undefined;
      disposalFailed = true;
    }

    const reasonCodes: McpLifecycleReasonCode[] = [];
    if (!drained) reasonCodes.push("active_requests_timeout");
    if (disposalTimedOut) reasonCodes.push("disposal_timeout");
    if (disposalFailed) reasonCodes.push("disposal_failed");
    if (termination && !termination.clean) {
      reasonCodes.push(termination.reasonCode);
      reasonCodes.push(...(termination.reasonCodes ?? []));
    }
    const uniqueReasonCodes = [...new Set(reasonCodes)];
    const cleanupPending = this.pendingDisposal !== undefined;
    const clean = uniqueReasonCodes.length === 0 && !cleanupPending;
    const reasonCode = uniqueReasonCodes[0];
    this.lifecycleState = clean ? "clean" : "non_clean";
    return {
      state: this.lifecycleState,
      clean,
      activeRequestCount: this.activeRequests.size,
      ...(reasonCode ? { reasonCode } : {}),
      ...(uniqueReasonCodes.length > 1 ? { reasonCodes: uniqueReasonCodes } : {}),
      ...(cleanupPending ? { cleanupPending: true } : {})
    };
  }

  private clearPendingDisposal(disposal: Promise<ProcessTerminationResult | void>): void {
    if (this.pendingDisposal === disposal) this.pendingDisposal = undefined;
  }

  private async waitForActiveRequests(deadlineAt: number): Promise<boolean> {
    while (this.activeRequests.size > 0) {
      const remainingMs = Math.max(0, deadlineAt - Date.now());
      if (remainingMs === 0) return false;
      const active = [...this.activeRequests];
      if (!(await settleBeforeDeadline(active, remainingMs))) return false;
    }
    return true;
  }
}

type DisposalObservation<T> = { kind: "fulfilled"; value: T } | { kind: "rejected"; error: unknown } | { kind: "timeout" };

function settleBeforeDeadline(promises: Promise<unknown>[], timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (completed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(completed);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    void Promise.allSettled(promises).then(() => finish(true));
  });
}

function observeDisposal<T>(promise: Promise<T>, deadlineAt: number): Promise<DisposalObservation<T>> {
  const remainingMs = Math.max(0, deadlineAt - Date.now());
  return new Promise((resolve) => {
    if (remainingMs === 0) {
      resolve({ kind: "timeout" });
      return;
    }
    const timer = setTimeout(() => resolve({ kind: "timeout" }), remainingMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve({ kind: "fulfilled", value });
      },
      (error) => {
        clearTimeout(timer);
        resolve({ kind: "rejected", error });
      }
    );
  });
}
