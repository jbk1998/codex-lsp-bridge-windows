export interface DiagnosticsWaiterControllerOptions {
  stabilityMs: number;
  getRevision: (uri: string) => number;
  getDocumentVersion: (uri: string) => number | undefined;
  getPublishedSourceRevision: (uri: string) => number | undefined;
}

interface DiagnosticsWaiter {
  minRevision: number;
  resolve: (fresh: boolean) => void;
  timer: NodeJS.Timeout;
  settleTimer?: NodeJS.Timeout;
  settleRevision?: number;
}

/** Owns diagnostics freshness waiters separately from provider recovery state. */
export class DiagnosticsWaiterController {
  private readonly waitersByUri = new Map<string, DiagnosticsWaiter[]>();

  constructor(private readonly options: DiagnosticsWaiterControllerOptions) {}

  wait(uri: string, minRevision: number, timeoutMs: number): Promise<boolean> {
    const currentRevision = this.options.getRevision(uri);
    const documentVersion = this.options.getDocumentVersion(uri);
    if (
      documentVersion !== undefined &&
      this.options.getPublishedSourceRevision(uri) === documentVersion &&
      currentRevision >= minRevision
    ) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      const waiter: DiagnosticsWaiter = {
        minRevision,
        resolve,
        timer: undefined as unknown as NodeJS.Timeout
      };
      waiter.timer = setTimeout(() => {
        this.removeWaiter(uri, waiter);
        waiter.resolve(false);
      }, timeoutMs);

      const waiters = this.waitersByUri.get(uri) ?? [];
      waiters.push(waiter);
      this.waitersByUri.set(uri, waiters);
      this.schedule(uri, currentRevision);
    });
  }

  schedule(uri: string, revision: number): void {
    const waiters = this.waitersByUri.get(uri) ?? [];
    for (const waiter of waiters) {
      if (revision < waiter.minRevision) continue;
      if (waiter.settleRevision === revision && waiter.settleTimer) continue;
      if (waiter.settleTimer) clearTimeout(waiter.settleTimer);
      waiter.settleRevision = revision;
      waiter.settleTimer = setTimeout(() => {
        const latestRevision = this.options.getRevision(uri);
        if (latestRevision !== revision || latestRevision < waiter.minRevision) {
          waiter.settleTimer = undefined;
          waiter.settleRevision = undefined;
          this.schedule(uri, latestRevision);
          return;
        }

        if (this.options.getPublishedSourceRevision(uri) !== this.options.getDocumentVersion(uri)) {
          waiter.settleTimer = undefined;
          waiter.settleRevision = undefined;
          return;
        }

        this.removeWaiter(uri, waiter);
        waiter.resolve(true);
      }, this.options.stabilityMs);
    }
  }

  cancel(): void {
    for (const waiters of this.waitersByUri.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        if (waiter.settleTimer) clearTimeout(waiter.settleTimer);
        waiter.resolve(false);
      }
    }
    this.waitersByUri.clear();
  }

  private removeWaiter(uri: string, waiter: DiagnosticsWaiter): void {
    if (waiter.settleTimer) clearTimeout(waiter.settleTimer);
    const nextWaiters = (this.waitersByUri.get(uri) ?? []).filter((candidate) => candidate !== waiter);
    if (nextWaiters.length > 0) this.waitersByUri.set(uri, nextWaiters);
    else this.waitersByUri.delete(uri);
  }
}
