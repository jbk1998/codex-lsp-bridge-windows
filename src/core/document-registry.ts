export interface OpenDocumentState {
  text: string;
  version: number;
}

/**
 * Keeps the provider's document manifest and serializes transitions per URI.
 * The manifest intentionally survives a client generation change so recovery
 * can reopen the exact latest state that the provider accepted.
 */
export class DocumentRegistry {
  private readonly documents = new Map<string, OpenDocumentState>();
  private readonly queues = new Map<string, Promise<void>>();

  get(uri: string): OpenDocumentState | undefined {
    return this.documents.get(uri);
  }

  set(uri: string, document: OpenDocumentState): void {
    this.documents.set(uri, document);
  }

  delete(uri: string): void {
    this.documents.delete(uri);
  }

  clear(): void {
    this.documents.clear();
  }

  entries(): Array<[string, OpenDocumentState]> {
    return [...this.documents.entries()].map(([uri, document]) => [uri, { ...document }]);
  }

  async runSerialized<T>(uri: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(uri) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tracked = current.then(
      () => undefined,
      () => undefined
    );
    this.queues.set(uri, tracked);

    try {
      return await current;
    } finally {
      if (this.queues.get(uri) === tracked) this.queues.delete(uri);
    }
  }
}
