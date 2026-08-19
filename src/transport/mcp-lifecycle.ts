import {
  createDisposalDeadline,
  type DisposalDeadline,
  type ProcessTerminationResult,
  type ProcessOwnershipReasonCode
} from "../core/process-ownership.js";

export type McpLifecycleState = "open" | "closing" | "draining" | "clean" | "non_clean";

export type McpLifecycleReasonCode = ProcessOwnershipReasonCode | "active_requests_timeout" | "disposal_failed" | "disposal_timeout";

export interface McpLifecycleResult {
  state: "clean" | "non_clean";
  clean: boolean;
  activeRequestCount: number;
  reasonCode?: McpLifecycleReasonCode;
}

export interface McpLifecycleOptions {
  dispose?: (deadline: DisposalDeadline) => Promise<ProcessTerminationResult | void>;
  createDeadline?: () => DisposalDeadline;
}

/**
 * Owns one MCP stdio connection's request and disposal boundary.
 *
 * The coordinator deliberately has no persistence or cancellation API. Work
 * that has started remains tracked until it settles; EOF only prevents new
 * work and starts one bounded disposal sequence.
 */
export class McpLifecycleCoordinator {
  private readonly activeRequests = new Set<Promise<unknown>>();
  private closePromise: Promise<McpLifecycleResult> | undefined;
  private lifecycleState: McpLifecycleState = "open";

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
      const disposal = this.options.dispose?.(deadline) ?? Promise.resolve(undefined);
      termination = await withDeadline(disposal, deadline.deadlineAt);
    } catch {
      disposalTimedOut = Date.now() >= deadline.deadlineAt;
      disposalFailed = !disposalTimedOut;
    }

    let reasonCode: McpLifecycleReasonCode | undefined;
    if (!drained) reasonCode = "active_requests_timeout";
    else if (disposalTimedOut) reasonCode = "disposal_timeout";
    else if (disposalFailed) reasonCode = "disposal_failed";
    else if (termination && !termination.clean) reasonCode = termination.reasonCode;
    const clean = reasonCode === undefined;
    this.lifecycleState = clean ? "clean" : "non_clean";
    return {
      state: this.lifecycleState,
      clean,
      activeRequestCount: this.activeRequests.size,
      ...(reasonCode ? { reasonCode } : {})
    };
  }

  private async waitForActiveRequests(deadlineAt: number): Promise<boolean> {
    while (this.activeRequests.size > 0) {
      const remainingMs = Math.max(0, deadlineAt - Date.now());
      if (remainingMs === 0) return false;
      const active = [...this.activeRequests];
      await Promise.race([Promise.allSettled(active), delay(remainingMs)]);
    }
    return true;
  }
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

function withDeadline<T>(promise: Promise<T>, deadlineAt: number): Promise<T> {
  const remainingMs = Math.max(0, deadlineAt - Date.now());
  if (remainingMs === 0) return Promise.reject(new Error("deadline exceeded"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("deadline exceeded")), remainingMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
