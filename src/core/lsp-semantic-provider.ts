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
}

export class LspSemanticProvider implements SemanticProvider {
  private initialized = false;
  private workspaceDocumentOpened = false;
  private diagnosticsByUri = new Map<string, Diagnostic[]>();
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
      await this.openDocument(uri);
      return [...(this.diagnosticsByUri.get(uri) ?? [])];
    }

    return [...this.diagnosticsByUri.values()].flat();
  }

  async definition(symbol: string): Promise<Location> {
    const match = await this.resolveSingleSymbol(symbol);
    return this.definitionAt(match);
  }

  async definitionAt(position: DocumentPosition): Promise<Location> {
    await this.openDocument(filePathToUri(position.file));
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
    await this.openDocument(filePathToUri(position.file));
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
    await this.openDocument(filePathToUri(position.file));
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

  private async openDocument(uri: string): Promise<void> {
    await this.ensureInitialized();
    const filePath = uriToFilePath(uri);
    const text = await fs.readFile(filePath, "utf8");
    this.client.notify("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: this.options.languageId,
        version: 1,
        text
      }
    });
  }

  private async ensureWorkspaceDocumentOpened(): Promise<void> {
    if (this.workspaceDocumentOpened) return;

    const seedFile = await this.findWorkspaceSeedFile();
    if (!seedFile) {
      throw new Error(`No ${this.options.languageId} workspace seed file found under ${this.options.rootPath}`);
    }

    await this.openDocument(filePathToUri(seedFile));
    this.workspaceDocumentOpened = true;
  }

  private async findWorkspaceSeedFile(): Promise<string | undefined> {
    for (const relativePath of this.options.workspaceSeedFiles ?? []) {
      const filePath = path.join(this.options.rootPath, relativePath);
      if (await fileExists(filePath)) return filePath;
    }

    return undefined;
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
