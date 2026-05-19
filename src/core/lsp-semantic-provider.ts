import fs from "node:fs/promises";
import path from "node:path";
import type { LspClient, ServerProcessConfig } from "./json-rpc-lsp-client.js";
import { lspSeverityToText } from "./diagnostics.js";
import type { Diagnostic, DocumentPosition, HoverInfo, Location, Position, SemanticProvider, SymbolMatch } from "./types.js";
import { filePathToUri, uriToFilePath } from "../utils/uri.js";

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

export interface LspSemanticProviderOptions {
  rootPath: string;
  languageId: string;
  server: ServerProcessConfig;
  clientFactory: (config: ServerProcessConfig) => LspClient;
  workspaceSeedFiles?: string[];
  workspaceSeedExtensions?: string[];
  diagnosticsTimeoutMs?: number;
}

export class LspSemanticProvider implements SemanticProvider {
  private initialized = false;
  private workspaceDocumentOpened = false;
  private diagnosticsByUri = new Map<string, Diagnostic[]>();
  private diagnosticsRevisionByUri = new Map<string, number>();
  private openedDocumentsByUri = new Map<string, { text: string; version: number }>();
  private diagnosticsWaitersByUri = new Map<
    string,
    Array<{
      minRevision: number;
      resolve: () => void;
      timer: NodeJS.Timeout;
    }>
  >();
  private client: LspClient;

  constructor(private readonly options: LspSemanticProviderOptions) {
    this.client = options.clientFactory(options.server);
    this.client.on("notification", (method: string, params: unknown) => {
      if (method === "textDocument/publishDiagnostics") {
        this.captureDiagnostics(params);
      }
    });
  }

  async diagnostics(uri?: string): Promise<Diagnostic[]> {
    await this.ensureInitialized();
    if (uri) {
      const currentRevision = this.diagnosticsRevisionByUri.get(uri) ?? 0;
      const documentChanged = await this.openOrUpdateDocument(uri);
      if (documentChanged || !this.diagnosticsByUri.has(uri)) {
        await this.waitForDiagnostics(uri, currentRevision + 1);
      }
      return [...(this.diagnosticsByUri.get(uri) ?? [])];
    }

    return [...this.diagnosticsByUri.values()].flat();
  }

  async definition(symbol: string): Promise<Location> {
    const match = await this.resolveSingleSymbol(symbol);
    return this.definitionAt(match);
  }

  async definitionAt(position: DocumentPosition): Promise<Location> {
    await this.openOrUpdateDocument(filePathToUri(position.file));
    if (this.options.languageId === "typescript") {
      const sourceDefinitions = await this.client.request<LspLocation[] | null>("workspace/executeCommand", {
        command: "_typescript.goToSourceDefinition",
        arguments: [filePathToUri(position.file), toLspPosition(position)]
      });
      if (!sourceDefinitions || sourceDefinitions.length === 0) {
        throw new Error(`No source definition found at ${formatPosition(position)}`);
      }
      return this.toLocation(sourceDefinitions[0]);
    }

    const result = await this.client.request<LspLocation | LspLocation[] | null>("textDocument/definition", {
      textDocument: { uri: filePathToUri(position.file) },
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
    await this.openOrUpdateDocument(filePathToUri(position.file));
    const result = await this.client.request<LspLocation[]>("textDocument/references", {
      textDocument: { uri: filePathToUri(position.file) },
      position: toLspPosition(position),
      context: { includeDeclaration: true }
    });
    return result.map((location) => this.toLocation(location));
  }

  async symbols(query: string): Promise<SymbolMatch[]> {
    await this.ensureInitialized();
    await this.ensureWorkspaceDocumentOpened();
    const symbols = await this.client.request<LspSymbol[]>("workspace/symbol", { query });
    return symbols.map((symbol) => ({
      ...this.toLocation(symbol.location),
      name: symbol.name,
      kind: typeof symbol.kind === "number" ? String(symbol.kind) : undefined,
      containerName: symbol.containerName
    }));
  }

  async hover(symbol: string): Promise<HoverInfo> {
    const match = await this.resolveSingleSymbol(symbol);
    return this.hoverAt(match);
  }

  async hoverAt(position: DocumentPosition): Promise<HoverInfo> {
    await this.openOrUpdateDocument(filePathToUri(position.file));
    const result = await this.client.request<LspHover | null>("textDocument/hover", {
      textDocument: { uri: filePathToUri(position.file) },
      position: toLspPosition(position)
    });
    if (!result) throw new Error(`No hover information found at ${formatPosition(position)}`);

    return {
      file: position.file,
      line: position.line,
      character: position.character,
      contents: normalizeHoverContents(result.contents)
    };
  }

  async dispose(): Promise<void> {
    await this.client.stop();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    await this.client.request("initialize", {
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
          symbol: {}
        }
      }
    });
    this.client.notify("initialized", {});
    this.initialized = true;
  }

  private async openOrUpdateDocument(uri: string): Promise<boolean> {
    await this.ensureInitialized();
    const filePath = uriToFilePath(uri);
    const text = await fs.readFile(filePath, "utf8");
    const opened = this.openedDocumentsByUri.get(uri);

    if (!opened) {
      this.openedDocumentsByUri.set(uri, { text, version: 1 });
      this.client.notify("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: this.options.languageId,
          version: 1,
          text
        }
      });
      return true;
    }

    if (opened.text === text) return false;

    const version = opened.version + 1;
    this.openedDocumentsByUri.set(uri, { text, version });
    this.client.notify("textDocument/didChange", {
      textDocument: {
        uri,
        version
      },
      contentChanges: [{ text }]
    });
    return true;
  }

  private async ensureWorkspaceDocumentOpened(): Promise<void> {
    if (this.workspaceDocumentOpened) return;

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

    const revision = (this.diagnosticsRevisionByUri.get(params.uri) ?? 0) + 1;
    this.diagnosticsRevisionByUri.set(params.uri, revision);
    this.diagnosticsByUri.set(
      params.uri,
      params.diagnostics.map((diagnostic) => ({
        file: uriToFilePath(params.uri),
        line: diagnostic.range.start.line + 1,
        character: diagnostic.range.start.character + 1,
        severity: lspSeverityToText(diagnostic.severity),
        message: diagnostic.message,
        source: diagnostic.source,
        code: diagnostic.code
      }))
    );
    this.resolveDiagnosticsWaiters(params.uri, revision);
  }

  private waitForDiagnostics(uri: string, minRevision: number): Promise<void> {
    const currentRevision = this.diagnosticsRevisionByUri.get(uri) ?? 0;
    if (currentRevision >= minRevision) return Promise.resolve();

    return new Promise((resolve) => {
      const waiters = this.diagnosticsWaitersByUri.get(uri) ?? [];
      const timer = setTimeout(() => {
        const nextWaiters = (this.diagnosticsWaitersByUri.get(uri) ?? []).filter((waiter) => waiter.resolve !== resolve);
        if (nextWaiters.length > 0) this.diagnosticsWaitersByUri.set(uri, nextWaiters);
        else this.diagnosticsWaitersByUri.delete(uri);
        resolve();
      }, this.options.diagnosticsTimeoutMs ?? 1500);

      waiters.push({ minRevision, resolve, timer });
      this.diagnosticsWaitersByUri.set(uri, waiters);
    });
  }

  private resolveDiagnosticsWaiters(uri: string, revision: number): void {
    const waiters = this.diagnosticsWaitersByUri.get(uri) ?? [];
    const pending = [];
    for (const waiter of waiters) {
      if (revision >= waiter.minRevision) {
        clearTimeout(waiter.timer);
        waiter.resolve();
      } else {
        pending.push(waiter);
      }
    }

    if (pending.length > 0) this.diagnosticsWaitersByUri.set(uri, pending);
    else this.diagnosticsWaitersByUri.delete(uri);
  }

  private toLocation(location: LspLocation): Location {
    return {
      file: uriToFilePath(location.uri),
      line: location.range.start.line + 1,
      character: location.range.start.character + 1,
      range: location.range
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

function isPublishDiagnosticsParams(value: unknown): value is { uri: string; diagnostics: LspDiagnostic[] } {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { uri?: unknown; diagnostics?: unknown };
  return typeof candidate.uri === "string" && Array.isArray(candidate.diagnostics);
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
