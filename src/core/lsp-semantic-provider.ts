import fs from "node:fs/promises";
import path from "node:path";
import type { LspClient, ServerProcessConfig } from "./json-rpc-lsp-client.js";
import type { DisposalDeadline, ProcessTerminationResult } from "./process-ownership.js";
import { lspSeverityToText } from "./diagnostics.js";
import type { Diagnostic, DiagnosticOptions, DiagnosticReport, DocumentPosition, HoverInfo, Location, Position, SemanticProvider, SymbolMatch } from "./types.js";
import { canonicalizeFileUri, filePathToUri, uriToFilePath } from "../utils/uri.js";
import {
  canonicalizeTargetPathSync,
  canonicalizeWorkspaceRootSync,
  isPathInsideWorkspaceRootSync,
  workspaceRootInstanceIdentitySync
} from "./workspace-root.js";
import { DocumentRegistry } from "./document-registry.js";
import { DiagnosticsWaiterController } from "./diagnostics-waiters.js";

interface LspDiagnostic {
  range: { start: Position; end: Position };
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}

interface LspLocation {
  uri: string;
  range: { start: Position; end: Position };
}

interface LspSymbol {
  name: string;
  kind?: number;
  containerName?: string;
  location: LspLocation;
}

interface LspHover {
  contents: string | { value: string } | Array<string | { value: string }>;
}

interface PublishDiagnosticsParams {
  uri: string;
  version?: number;
  diagnostics: LspDiagnostic[];
}

interface PendingSourceRevision {
  generation: number;
  version: number;
}

interface DiagnosticsCandidate {
  generation: number;
  revision: number;
  sourceRevision: number;
  settleTimer?: NodeJS.Timeout;
}

const defaultDiagnosticsTimeoutMs = 15000;
const defaultDiagnosticsStabilityMs = 250;

export interface LspSemanticProviderOptions {
  rootPath: string;
  languageId: string;
  server: ServerProcessConfig;
  clientFactory: (config: ServerProcessConfig) => LspClient;
  workspaceSeedFiles?: string[];
  workspaceSeedExtensions?: string[];
  diagnosticsTimeoutMs?: number;
  diagnosticsStabilityMs?: number;
  inferredProjectCompilerOptions?: Record<string, unknown>;
  rootInstanceIdentity?: string;
}

export type LspProviderState = "new" | "initializing" | "ready" | "exited" | "recovering" | "failed" | "closing";

export class LspSemanticProvider implements SemanticProvider {
  private initialized = false;
  private workspaceDocumentOpened = false;
  private state: LspProviderState = "new";
  private generation = 0;
  private initializationPromise: Promise<void> | undefined;
  private recoveryPromise: Promise<void> | undefined;
  private workspaceOpenPromise: Promise<void> | undefined;
  private disposePromise: Promise<ProcessTerminationResult | void> | undefined;
  private disposed = false;
  private diagnosticsByUri = new Map<string, Diagnostic[]>();
  private diagnosticsRevisionByUri = new Map<string, number>();
  private diagnosticsSourceRevisionByUri = new Map<string, number>();
  private pendingSourceRevisionByUri = new Map<string, PendingSourceRevision>();
  private diagnosticsCandidatesByUri = new Map<string, DiagnosticsCandidate>();
  private readonly documentRegistry = new DocumentRegistry();
  private configurationIssues: string[] = [];
  private readonly diagnosticsWaiters: DiagnosticsWaiterController;
  private readonly rootRealPathPromise: Promise<string>;
  private readonly rootInstanceIdentity: string;
  private client: LspClient;

  constructor(private readonly options: LspSemanticProviderOptions) {
    this.rootInstanceIdentity = options.rootInstanceIdentity ?? workspaceRootInstanceIdentitySync(options.rootPath);
    this.rootRealPathPromise = Promise.resolve(canonicalizeWorkspaceRootSync(options.rootPath));
    this.diagnosticsWaiters = new DiagnosticsWaiterController({
      stabilityMs: options.diagnosticsStabilityMs ?? defaultDiagnosticsStabilityMs,
      getRevision: (uri) => this.diagnosticsRevisionByUri.get(uri) ?? 0,
      getDocumentVersion: (uri) => this.documentRegistry.get(uri)?.version,
      getPublishedSourceRevision: (uri) => this.diagnosticsSourceRevisionByUri.get(uri)
    });
    this.client = this.createClient();
  }

  private createClient(): LspClient {
    const client = this.options.clientFactory(this.options.server);
    client.on("notification", (method: string, params: unknown) => {
      if (
        !this.disposed &&
        client === this.client &&
        method === "textDocument/publishDiagnostics"
      ) this.captureDiagnostics(params);
    });
    client.on("exit", () => this.handleClientExit(client));
    return client;
  }

  private handleClientExit(client: LspClient): void {
    if (this.disposed || client !== this.client || this.state === "closing") return;
    this.generation += 1;
    this.initialized = false;
    this.workspaceDocumentOpened = false;
    this.workspaceOpenPromise = undefined;
    this.state = "exited";
    this.diagnosticsByUri.clear();
    this.diagnosticsRevisionByUri.clear();
    this.diagnosticsSourceRevisionByUri.clear();
    this.pendingSourceRevisionByUri.clear();
    this.cancelDiagnosticsCandidates();
    this.configurationIssues = [];
    this.diagnosticsWaiters.cancel();
  }

  async diagnostics(uri?: string, options: DiagnosticOptions = {}): Promise<DiagnosticReport> {
    if (!this.isRootInstanceCurrent()) return this.rootUnavailableReport();
    const timeoutMs = Math.max(0, options.timeoutMs ?? this.options.diagnosticsTimeoutMs ?? defaultDiagnosticsTimeoutMs);
    const deadlineAt = Date.now() + timeoutMs;
    const initialized = await this.ensureInitializedForDiagnostics(deadlineAt);
    if (!initialized.ok) {
      return {
        status: initialized.timedOut ? "timed_out" : "unavailable",
        timedOut: initialized.timedOut,
        stale: initialized.timedOut,
        ...(initialized.timedOut ? {} : { unavailableReason: initialized.reason }),
        configurationIssues: [...this.configurationIssues],
        items: []
      };
    }

    if (uri) {
      let document: { uri: string; filePath: string };
      try {
        document = await withDiagnosticsDeadline(this.resolveDocument(uri), deadlineAt);
      } catch (error) {
        if (isDiagnosticsDeadlineExceeded(error)) return this.timedOutReport();
        if (isWorkspaceRootChangedError(error)) return this.rootUnavailableReport();
        throw error;
      }
      const currentRevision = this.diagnosticsRevisionByUri.get(document.uri) ?? 0;
      let openedDocument: { uri: string; filePath: string; changed: boolean; sourceRevision: number };
      try {
        openedDocument = await withDiagnosticsDeadline(this.openOrUpdateDocument(document.uri), deadlineAt);
      } catch (error) {
        if (isDiagnosticsDeadlineExceeded(error)) return this.timedOutReport(document.uri);
        if (isWorkspaceRootChangedError(error)) return this.rootUnavailableReport();
        throw error;
      }
      let timedOut = false;
      const publishedSourceRevision = this.diagnosticsSourceRevisionByUri.get(document.uri);
      if (
        openedDocument.changed ||
        !this.diagnosticsByUri.has(document.uri) ||
        publishedSourceRevision !== openedDocument.sourceRevision
      ) {
        // Recovery may reopen a document and receive its fresh diagnostics before
        // this call can register a waiter. The current revision is therefore the
        // baseline; the source-revision check still prevents an old notification
        // from being accepted for a changed document.
        const remainingMs = Math.max(0, deadlineAt - Date.now());
        timedOut = remainingMs === 0 || !(await this.diagnosticsWaiters.wait(document.uri, currentRevision, remainingMs));
      }
      const sourceRevision = openedDocument.sourceRevision;
      const stale = timedOut || this.diagnosticsSourceRevisionByUri.get(document.uri) !== sourceRevision;
      return {
        status: timedOut ? "timed_out" : "ok",
        timedOut,
        stale,
        configurationIssues: [...this.configurationIssues],
        sourceRevision,
        items: [...(this.diagnosticsByUri.get(document.uri) ?? [])]
      };
    }

    const documents = this.documentRegistry.entries();
    const sourceRevisions = documents.map(([, document]) => document.version);
    const stale = documents.some(
      ([uri, document]) => this.diagnosticsSourceRevisionByUri.get(uri) !== document.version
    );
    return {
      status: "ok",
      timedOut: false,
      stale,
      configurationIssues: [...this.configurationIssues],
      sourceRevision: sourceRevisions.length > 0 ? Math.max(...sourceRevisions) : undefined,
      items: [...this.diagnosticsByUri.values()].flat()
    };
  }

  private async ensureInitializedForDiagnostics(
    deadlineAt: number
  ): Promise<{ ok: true } | { ok: false; reason: string; timedOut: boolean }> {
    try {
      await withDiagnosticsDeadline(this.ensureInitialized(), deadlineAt);
      return { ok: true };
    } catch (error) {
      if (isDiagnosticsDeadlineExceeded(error)) {
        return { ok: false, reason: "LSP initialization exceeded the diagnostics timeout", timedOut: true };
      }
      if (isWorkspaceRootChangedError(error)) {
        return { ok: false, reason: formatInitializationFailure(error), timedOut: false };
      }
      return { ok: false, reason: formatInitializationFailure(error), timedOut: false };
    }
  }

  async definition(symbol: string): Promise<Location> {
    const match = await this.resolveSingleSymbol(symbol);
    return this.definitionAt(match);
  }

  async definitionAt(position: DocumentPosition): Promise<Location> {
    const document = await this.openOrUpdateDocument(filePathToUri(position.file));
    if (this.options.languageId === "typescript") {
      const sourceDefinitions = await this.requestWithRecovery<LspLocation[] | null>("workspace/executeCommand", {
        command: "_typescript.goToSourceDefinition",
        arguments: [document.uri, toLspPosition(position)]
      });
      if (!sourceDefinitions || sourceDefinitions.length === 0) {
        throw new Error(`No source definition found at ${formatPosition(position)}`);
      }
      return this.toLocation(sourceDefinitions[0]);
    }

    const result = await this.requestWithRecovery<LspLocation | LspLocation[] | null>("textDocument/definition", {
      textDocument: { uri: document.uri },
      position: toLspPosition(position)
    });
    const location = Array.isArray(result) ? result[0] : result;
    if (!location) throw new Error(`No definition found at ${formatPosition(position)}`);
    return this.toLocation(location);
  }

  async references(symbol: string): Promise<Location[]> {
    const match = await this.resolveSingleSymbol(symbol);
    return this.referencesAt(match);
  }

  async referencesAt(position: DocumentPosition): Promise<Location[]> {
    const document = await this.openOrUpdateDocument(filePathToUri(position.file));
    const result = await this.requestWithRecovery<LspLocation[]>("textDocument/references", {
      textDocument: { uri: document.uri },
      position: toLspPosition(position),
      context: { includeDeclaration: true }
    });
    return result.map((location) => this.toLocation(location));
  }

  async symbols(query: string): Promise<SymbolMatch[]> {
    await this.ensureInitialized();
    await this.ensureWorkspaceDocumentOpened();
    const symbols = await this.requestWithRecovery<LspSymbol[]>("workspace/symbol", { query });
    return symbols.map((symbol) => ({
      ...this.toLocation(symbol.location),
      name: symbol.name,
      kind: typeof symbol.kind === "number" ? symbolKindName(symbol.kind) : undefined,
      containerName: symbol.containerName
    }));
  }

  async hover(symbol: string): Promise<HoverInfo> {
    const match = await this.resolveSingleSymbol(symbol);
    return this.hoverAt(match);
  }

  async hoverAt(position: DocumentPosition): Promise<HoverInfo> {
    const document = await this.openOrUpdateDocument(filePathToUri(position.file));
    const result = await this.requestWithRecovery<LspHover | null>("textDocument/hover", {
      textDocument: { uri: document.uri },
      position: toLspPosition(position)
    });
    if (!result) throw new Error(`No hover information found at ${formatPosition(position)}`);

    return {
      file: document.filePath,
      line: position.line,
      character: position.character,
      contents: normalizeHoverContents(result.contents)
    };
  }

  async dispose(deadline?: DisposalDeadline): Promise<ProcessTerminationResult | void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.state = "closing";
    if (this.initialized) {
      for (const [uri] of this.documentRegistry.entries()) {
        this.client.notify("textDocument/didClose", {
          textDocument: { uri }
        });
      }
    }
    this.documentRegistry.clear();
    this.cancelDiagnosticsCandidates();
    this.diagnosticsWaiters.cancel();
    this.disposePromise = this.client.stop(deadline);
    return this.disposePromise;
  }

  private async ensureInitialized(): Promise<void> {
    this.assertRootInstanceCurrent();
    if (this.disposed) throw new Error("LSP provider is closing");
    if (this.initialized && this.state === "ready") return;
    if (this.state === "failed") throw new Error("LSP server recovery failed");

    if (this.recoveryPromise) return this.recoveryPromise;

    if (this.state === "exited" || this.state === "recovering") {
      if (!this.recoveryPromise) {
        const generation = this.generation;
        this.state = "recovering";
        const recovery = this.recoverGeneration(generation);
        const trackedRecovery = recovery.finally(() => {
          if (this.recoveryPromise === trackedRecovery) this.recoveryPromise = undefined;
        });
        this.recoveryPromise = trackedRecovery;
      }
      return this.recoveryPromise;
    }

    if (!this.initializationPromise) {
      this.state = "initializing";
      const initialization = this.initializeGeneration(this.client, this.generation, false);
      const trackedInitialization = initialization.finally(() => {
        if (this.initializationPromise === trackedInitialization) this.initializationPromise = undefined;
      });
      this.initializationPromise = trackedInitialization;
    }
    return this.initializationPromise;
  }

  private async requestWithRecovery<T>(method: string, params?: unknown): Promise<T> {
    let retried = false;

    while (true) {
      await this.ensureInitialized();
      const client = this.client;
      const generation = this.generation;

      try {
        return await client.request<T>(method, params);
      } catch (error) {
        const racedWithExit = client !== this.client || generation !== this.generation;
        if (retried || !racedWithExit || this.disposed) throw error;
        retried = true;
        await this.ensureInitialized();
      }
    }
  }

  private async notifyWithRecovery(method: string, params: unknown): Promise<void> {
    const client = this.client;
    const generation = this.generation;

    try {
      client.notify(method, params);
    } catch (error) {
      const racedWithExit = client !== this.client || generation !== this.generation;
      if (!racedWithExit || this.disposed) throw error;
      await this.ensureInitialized();
      return;
    }

    if (client !== this.client || generation !== this.generation) await this.ensureInitialized();
  }

  private markDocumentPending(uri: string, version: number): void {
    this.assertRootInstanceCurrent();
    this.invalidateDiagnosticsCandidate(uri);
    this.pendingSourceRevisionByUri.set(uri, { generation: this.generation, version });
  }

  private async recoverGeneration(generation: number): Promise<void> {
    try {
      const client = this.createClient();
      this.client = client;
      await this.initializeGeneration(client, generation, true);
    } catch (error) {
      if (!this.disposed) this.state = "failed";
      throw error;
    }
  }

  private async initializeGeneration(client: LspClient, generation: number, reopenDocuments: boolean): Promise<void> {
    try {
      await client.request("initialize", {
        processId: process.pid,
        rootPath: this.options.rootPath,
        rootUri: filePathToUri(this.options.rootPath),
        workspaceFolders: [
          {
            uri: filePathToUri(this.options.rootPath),
            name: path.basename(this.options.rootPath)
          }
        ],
        capabilities: {
          textDocument: {
            publishDiagnostics: {},
            definition: {},
            references: {},
            hover: {}
          },
          workspace: {
            symbol: {},
            workspaceFolders: true
          }
        }
      });
      client.notify("initialized", {});

      this.configurationIssues = [];
      if (this.options.inferredProjectCompilerOptions) {
        try {
          await client.request("workspace/executeCommand", {
            command: "typescript.tsserverRequest",
            arguments: [
              "compilerOptionsForInferredProjects",
              { options: this.options.inferredProjectCompilerOptions },
              { expectsResult: true }
            ]
          });
        } catch (error) {
          this.configurationIssues.push(
            `Could not apply inferred TypeScript project options: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      if (reopenDocuments) {
        for (const [uri, document] of this.documentRegistry.entries()) {
          this.pendingSourceRevisionByUri.set(uri, { generation, version: document.version });
          client.notify("textDocument/didOpen", {
            textDocument: {
              uri,
              languageId: this.options.languageId,
              version: document.version,
              text: document.text
            }
          });
        }
        this.workspaceDocumentOpened = this.documentRegistry.entries().length > 0;
      }

      this.assertRootInstanceCurrent();
      if (generation !== this.generation || this.disposed) throw new Error("LSP server exited during initialization");
      this.initialized = true;
      this.state = "ready";
    } catch (error) {
      if (!this.disposed) this.state = "failed";
      throw error;
    }
  }

  private async openOrUpdateDocument(uri: string): Promise<{ uri: string; filePath: string; changed: boolean; sourceRevision: number }> {
    await this.ensureInitialized();
    const document = await this.resolveDocument(uri);
    return this.documentRegistry.runSerialized(document.uri, async () => {
      const text = await fs.readFile(document.filePath, "utf8");
      const opened = this.documentRegistry.get(document.uri);

      if (!opened) {
        const version = 1;
        this.documentRegistry.set(document.uri, { text, version });
        this.markDocumentPending(document.uri, version);
        await this.notifyWithRecovery("textDocument/didOpen", {
          textDocument: {
            uri: document.uri,
            languageId: this.options.languageId,
            version,
            text
          }
        });
        return { ...document, changed: true, sourceRevision: version };
      }

      if (opened.text === text) return { ...document, changed: false, sourceRevision: opened.version };

      const version = opened.version + 1;
      this.documentRegistry.set(document.uri, { text, version });
      this.markDocumentPending(document.uri, version);
      await this.notifyWithRecovery("textDocument/didChange", {
        textDocument: {
          uri: document.uri,
          version
        },
        contentChanges: [{ text }]
      });
      return { ...document, changed: true, sourceRevision: version };
    });
  }

  private async ensureWorkspaceDocumentOpened(): Promise<void> {
    if (this.workspaceDocumentOpened) return;
    if (this.workspaceOpenPromise) return this.workspaceOpenPromise;

    const opening = this.openWorkspaceDocument();
    const trackedOpening = opening.finally(() => {
      if (this.workspaceOpenPromise === trackedOpening) this.workspaceOpenPromise = undefined;
    });
    this.workspaceOpenPromise = trackedOpening;
    return trackedOpening;
  }

  private async openWorkspaceDocument(): Promise<void> {
    const seedFile = await this.findWorkspaceSeedFile();
    if (!seedFile) {
      throw new Error(`No ${this.options.languageId} workspace seed file found under ${this.options.rootPath}`);
    }

    await this.openOrUpdateDocument(filePathToUri(seedFile));
    this.workspaceDocumentOpened = true;
  }

  private async findWorkspaceSeedFile(): Promise<string | undefined> {
    for (const relativePath of this.options.workspaceSeedFiles ?? []) {
      const filePath = path.join(this.options.rootPath, relativePath);
      if (await fileExists(filePath)) return filePath;
    }

    return findFirstSourceFile(this.options.rootPath, this.options.workspaceSeedExtensions ?? []);
  }

  private async resolveSingleSymbol(symbol: string): Promise<SymbolMatch> {
    const matches = (await this.symbols(symbol)).filter((match) => match.name === symbol);
    if (matches.length === 0) throw new Error(`Symbol not found: ${symbol}`);
    if (matches.length > 1) {
      const locations = matches.map((match) => `${path.relative(this.options.rootPath, match.file)}:${match.line}`).join(", ");
      throw new Error(`Symbol is ambiguous: ${symbol} (${locations})`);
    }
    return matches[0];
  }

  private captureDiagnostics(params: unknown): void {
    if (!isPublishDiagnosticsParams(params)) return;
    let uri: string;
    try {
      uri = this.canonicalizeProviderUri(params.uri);
    } catch {
      return;
    }

    const pending = this.pendingSourceRevisionByUri.get(uri);
    const document = this.documentRegistry.get(uri);
    if (!pending || !document || pending.version !== document.version) return;
    if (params.version !== undefined && params.version !== document.version) return;

    const revision = (this.diagnosticsRevisionByUri.get(uri) ?? 0) + 1;
    this.diagnosticsRevisionByUri.set(uri, revision);
    this.diagnosticsByUri.set(
      uri,
      params.diagnostics.map((diagnostic) => ({
        file: uriToFilePath(uri),
        line: diagnostic.range.start.line + 1,
        character: diagnostic.range.start.character + 1,
        severity: lspSeverityToText(diagnostic.severity),
        message: diagnostic.message,
        source: diagnostic.source,
        code: diagnostic.code
      }))
    );
    const candidate: DiagnosticsCandidate = {
      generation: pending.generation,
      revision,
      sourceRevision: pending.version
    };
    this.diagnosticsCandidatesByUri.set(uri, candidate);
    candidate.settleTimer = setTimeout(
      () => this.commitDiagnosticsCandidate(uri, candidate),
      this.options.diagnosticsStabilityMs ?? defaultDiagnosticsStabilityMs
    );
    this.diagnosticsWaiters.schedule(uri, revision);
  }

  private async resolveDocument(uri: string): Promise<{ uri: string; filePath: string }> {
    this.assertRootInstanceCurrent();
    const inputPath = path.resolve(uriToFilePath(uri));
    let realFilePath: string;
    try {
      realFilePath = await fs.realpath(inputPath);
    } catch {
      const canonicalUri = filePathToUri(inputPath);
      if (this.documentRegistry.get(canonicalUri)) {
        await this.documentRegistry.runSerialized(canonicalUri, async () => {
          if (!this.documentRegistry.get(canonicalUri)) return;
          this.documentRegistry.delete(canonicalUri);
          this.invalidateDiagnosticsCandidate(canonicalUri);
          await this.notifyWithRecovery("textDocument/didClose", {
            textDocument: { uri: canonicalUri }
          });
        });
      }
      throw new Error(`File not found: ${inputPath}`);
    }

    const realRootPath = await this.rootRealPathPromise;
    this.assertRootInstanceCurrent();
    const canonicalFilePath = canonicalizeTargetPathSync(realFilePath);
    if (!isPathInsideWorkspaceRootSync(canonicalFilePath, realRootPath)) {
      throw new Error(`File is outside workspace root: ${inputPath}`);
    }

    return {
      uri: filePathToUri(canonicalFilePath),
      filePath: canonicalFilePath
    };
  }

  private commitDiagnosticsCandidate(uri: string, candidate: DiagnosticsCandidate): void {
    if (this.diagnosticsCandidatesByUri.get(uri) !== candidate) return;
    const document = this.documentRegistry.get(uri);
    const pending = this.pendingSourceRevisionByUri.get(uri);
    const isCurrent =
      candidate.generation === this.generation &&
      document?.version === candidate.sourceRevision &&
      pending?.generation === candidate.generation &&
      pending.version === candidate.sourceRevision &&
      this.diagnosticsRevisionByUri.get(uri) === candidate.revision;

    this.diagnosticsCandidatesByUri.delete(uri);
    candidate.settleTimer = undefined;
    if (!isCurrent) return;

    this.diagnosticsSourceRevisionByUri.set(uri, candidate.sourceRevision);
    this.pendingSourceRevisionByUri.delete(uri);
    this.diagnosticsWaiters.schedule(uri, candidate.revision);
  }

  private invalidateDiagnosticsCandidate(uri: string): void {
    const candidate = this.diagnosticsCandidatesByUri.get(uri);
    if (candidate?.settleTimer) clearTimeout(candidate.settleTimer);
    this.diagnosticsCandidatesByUri.delete(uri);
  }

  private cancelDiagnosticsCandidates(): void {
    for (const candidate of this.diagnosticsCandidatesByUri.values()) {
      if (candidate.settleTimer) clearTimeout(candidate.settleTimer);
    }
    this.diagnosticsCandidatesByUri.clear();
  }

  private canonicalizeProviderUri(uri: string): string {
    this.assertRootInstanceCurrent();
    const filePath = canonicalizeTargetPathSync(uriToFilePath(canonicalizeFileUri(uri)));
    const rootPath = canonicalizeWorkspaceRootSync(this.options.rootPath);
    if (!isPathInsideWorkspaceRootSync(filePath, rootPath)) {
      throw new Error(`Location is outside workspace root: ${filePath}`);
    }
    return filePathToUri(filePath);
  }

  private toLocation(location: LspLocation): Location {
    const uri = this.canonicalizeProviderUri(location.uri);
    return {
      file: uriToFilePath(uri),
      line: location.range.start.line + 1,
      character: location.range.start.character + 1,
      range: location.range
    };
  }

  private isRootInstanceCurrent(): boolean {
    return workspaceRootInstanceIdentitySync(this.options.rootPath) === this.rootInstanceIdentity;
  }

  private assertRootInstanceCurrent(): void {
    if (!this.isRootInstanceCurrent()) {
      throw new WorkspaceRootChangedError(this.options.rootPath);
    }
  }

  private rootUnavailableReport(): DiagnosticReport {
    return {
      status: "unavailable",
      timedOut: false,
      stale: true,
      unavailableReason: `Workspace root instance changed: ${this.options.rootPath} (root_replaced)`,
      configurationIssues: [...this.configurationIssues],
      items: []
    };
  }

  private timedOutReport(uri?: string): DiagnosticReport {
    const sourceUri = uri ? this.canonicalizeProviderUri(uri) : undefined;
    const document = sourceUri ? this.documentRegistry.get(sourceUri) : undefined;
    return {
      status: "timed_out",
      timedOut: true,
      stale: true,
      configurationIssues: [...this.configurationIssues],
      ...(document ? { sourceRevision: document.version, items: [...(this.diagnosticsByUri.get(sourceUri!) ?? [])] } : { items: [] })
    };
  }
}

function normalizeHoverContents(contents: LspHover["contents"]): string {
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) {
    return contents.map((item) => (typeof item === "string" ? item : item.value)).join("\n\n");
  }
  return contents.value;
}

function isPublishDiagnosticsParams(value: unknown): value is PublishDiagnosticsParams {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { uri?: unknown; version?: unknown; diagnostics?: unknown };
  return typeof candidate.uri === "string" && Array.isArray(candidate.diagnostics) &&
    (candidate.version === undefined || typeof candidate.version === "number");
}

function isMissingLanguageServerError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Failed to start LSP server");
}

function formatInitializationFailure(error: unknown): string {
  if (isMissingLanguageServerError(error)) return error instanceof Error ? error.message : "Language server unavailable";
  if (error instanceof Error && error.message.includes("LSP server exited")) return "LSP server exited before the request completed (server_exited)";
  if (error instanceof Error && error.message === "LSP server recovery failed") return "LSP server recovery failed (server_exited)";
  if (isWorkspaceRootChangedError(error)) return `${error.message}`;
  return error instanceof Error ? `${error.message} (server_exited)` : "Language server unavailable (server_exited)";
}

class WorkspaceRootChangedError extends Error {
  constructor(rootPath: string) {
    super(`Workspace root instance changed: ${rootPath} (root_replaced)`);
    this.name = "WorkspaceRootChangedError";
  }
}

class DiagnosticsDeadlineExceededError extends Error {
  constructor() {
    super("diagnostics deadline exceeded");
    this.name = "DiagnosticsDeadlineExceededError";
  }
}

function isWorkspaceRootChangedError(error: unknown): error is WorkspaceRootChangedError {
  return error instanceof WorkspaceRootChangedError;
}

function isDiagnosticsDeadlineExceeded(error: unknown): error is DiagnosticsDeadlineExceededError {
  return error instanceof DiagnosticsDeadlineExceededError;
}

function withDiagnosticsDeadline<T>(promise: Promise<T>, deadlineAt: number): Promise<T> {
  const remainingMs = Math.max(0, deadlineAt - Date.now());
  if (remainingMs === 0) return Promise.reject(new DiagnosticsDeadlineExceededError());
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DiagnosticsDeadlineExceededError()), remainingMs);
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

function toLspPosition(position: DocumentPosition): Position {
  return {
    line: position.line - 1,
    character: position.character - 1
  };
}

function formatPosition(position: DocumentPosition): string {
  return `${position.file}:${position.line}:${position.character}`;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function symbolKindName(kind: number): string {
  const names: Record<number, string> = {
    1: "File",
    2: "Module",
    3: "Namespace",
    4: "Package",
    5: "Class",
    6: "Method",
    7: "Property",
    8: "Field",
    9: "Constructor",
    10: "Enum",
    11: "Interface",
    12: "Function",
    13: "Variable",
    14: "Constant",
    15: "String",
    16: "Number",
    17: "Boolean",
    18: "Array",
    19: "Object",
    20: "Key",
    21: "Null",
    22: "EnumMember",
    23: "Struct",
    24: "Event",
    25: "Operator",
    26: "TypeParameter"
  };
  return names[kind] ?? `Unknown(${kind})`;
}

const skippedDirectories = new Set([
  ".git",
  ".next",
  ".turbo",
  ".vercel",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out"
]);

async function findFirstSourceFile(rootPath: string, extensions: string[]): Promise<string | undefined> {
  if (extensions.length === 0) return undefined;

  const queue = [rootPath];
  while (queue.length > 0) {
    const directory = queue.shift()!;
    const entries = await readDirectory(directory);
    const sorted = entries.sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? 1 : -1;
      return left.name.localeCompare(right.name);
    });

    for (const entry of sorted) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isFile() && extensions.includes(path.extname(entry.name))) return entryPath;
      if (entry.isDirectory() && !skippedDirectories.has(entry.name)) queue.push(entryPath);
    }
  }

  return undefined;
}

async function readDirectory(directory: string): Promise<import("node:fs").Dirent[]> {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}
