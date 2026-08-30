import {
  aggregateTerminationResults,
  createDisposalDeadline,
  type DisposalDeadline,
  type ProcessTerminationResult
} from "./process-ownership.js";

/**
 * The small lifecycle surface the root registry needs from a manager. Keeping
 * this interface narrower than LspManager makes root replacement cleanup
 * unit-testable without starting language servers.
 */
export interface ManagedManager {
  suspend(deadline?: DisposalDeadline): Promise<ProcessTerminationResult | void>;
  dispose(deadline?: DisposalDeadline): Promise<ProcessTerminationResult | void>;
}

export interface ManagerRegistryLookup<M extends ManagedManager> {
  manager: M;
  created: boolean;
  replaced: boolean;
}

export interface ManagerRegistryOptions {
  createDisposalDeadline?: () => DisposalDeadline;
}

/**
 * Owns the managers used by one live MCP connection.
 *
 * A canonical root may be reused only while its directory-instance identity
 * is unchanged. When that identity changes, the previous manager is retired
 * and receives one bounded disposal attempt. A cleanly completed retirement
 * is removed immediately; a non-clean or rejected attempt remains visible so
 * final disposal can report (and retry) the outstanding ownership problem.
 */
export class ManagerRegistry<M extends ManagedManager> {
  private readonly activeManagers = new Map<string, { instanceIdentity: string; manager: M }>();
  private readonly retiredManagers = new Set<M>();
  private readonly pendingDisposals = new Map<M, Promise<ProcessTerminationResult | void>>();

  constructor(private readonly options: ManagerRegistryOptions = {}) {}

  get activeCount(): number {
    return this.activeManagers.size;
  }

  get retiredCount(): number {
    return this.retiredManagers.size;
  }

  /**
   * Return the manager for a root, replacing it when the directory instance
   * changed. The identity strings are supplied by the workspace-root layer so
   * this class can be tested with deterministic identities.
   */
  getOrCreate(rootIdentity: string, instanceIdentity: string, createManager: () => M): ManagerRegistryLookup<M> {
    const existing = this.activeManagers.get(rootIdentity);
    if (existing?.instanceIdentity === instanceIdentity) {
      return { manager: existing.manager, created: false, replaced: false };
    }

    if (existing) this.retire(existing.manager);
    const manager = createManager();
    this.activeManagers.set(rootIdentity, { instanceIdentity, manager });
    return { manager, created: true, replaced: existing !== undefined };
  }

  /** Return a de-duplicated snapshot of active and retired managers. */
  allManagers(): M[] {
    return [...new Set([...[...this.activeManagers.values()].map((entry) => entry.manager), ...this.retiredManagers])];
  }

  async suspendAll(deadline: DisposalDeadline = createDisposalDeadline()): Promise<ProcessTerminationResult | void> {
    // Retired managers already have disposal in flight (or have completed a
    // failed attempt). They are intentionally excluded from idle suspension;
    // final disposal still includes them for ownership reporting and retry.
    const activeManagers = [...new Set([...this.activeManagers.values()].map((entry) => entry.manager))];
    return this.runLifecycle(activeManagers, (manager) => manager.suspend(deadline));
  }

  async disposeAll(deadline: DisposalDeadline = createDisposalDeadline()): Promise<ProcessTerminationResult | void> {
    return this.runLifecycle(this.allManagers(), (manager) => this.disposeManager(manager, deadline));
  }

  private retire(manager: M): void {
    this.retiredManagers.add(manager);
    void this.disposeManager(manager, this.options.createDisposalDeadline?.() ?? createDisposalDeadline()).catch(() => {
      // The manager remains in retiredManagers so final disposal can retry and
      // preserve the non-clean ownership evidence.
    });
  }

  private disposeManager(manager: M, deadline: DisposalDeadline): Promise<ProcessTerminationResult | void> {
    const pending = this.pendingDisposals.get(manager);
    if (pending) return pending;

    const disposal = Promise.resolve().then(() => manager.dispose(deadline));
    this.pendingDisposals.set(manager, disposal);
    void disposal.then(
      (result) => {
        this.pendingDisposals.delete(manager);
        if (!result || result.clean) this.retiredManagers.delete(manager);
      },
      () => {
        this.pendingDisposals.delete(manager);
      }
    );
    return disposal;
  }

  private async runLifecycle(
    managers: M[],
    operation: (manager: M) => Promise<ProcessTerminationResult | void>
  ): Promise<ProcessTerminationResult | void> {
    const settled = await Promise.allSettled(managers.map((manager) => Promise.resolve().then(() => operation(manager))));
    const results = settled.map((entry) => (entry.status === "fulfilled" ? entry.value : undefined));
    return aggregateTerminationResults(results, settled.filter((entry) => entry.status === "rejected").length);
  }
}
