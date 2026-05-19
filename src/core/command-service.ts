import { summarizeDiagnostics } from "./diagnostics.js";
import type { DiagnosticSummary, DocumentPosition, HoverInfo, Location, SemanticProvider, SymbolMatch } from "./types.js";

export class CommandService {
  constructor(private readonly provider: SemanticProvider) {}

  async diagnostics(uri?: string): Promise<DiagnosticSummary> {
    return summarizeDiagnostics(await this.provider.diagnostics(uri));
  }

  async definition(symbol: string): Promise<Location> {
    assertNonEmpty("symbol", symbol);
    return this.provider.definition(symbol);
  }

  async definitionAt(position: DocumentPosition): Promise<Location> {
    assertPosition(position);
    return this.provider.definitionAt(position);
  }

  async references(symbol: string): Promise<Location[]> {
    assertNonEmpty("symbol", symbol);
    return this.provider.references(symbol);
  }

  async referencesAt(position: DocumentPosition): Promise<Location[]> {
    assertPosition(position);
    return this.provider.referencesAt(position);
  }

  async symbols(query: string): Promise<SymbolMatch[]> {
    assertNonEmpty("query", query);
    return this.provider.symbols(query);
  }

  async hover(symbol: string): Promise<HoverInfo> {
    assertNonEmpty("symbol", symbol);
    return this.provider.hover(symbol);
  }

  async hoverAt(position: DocumentPosition): Promise<HoverInfo> {
    assertPosition(position);
    return this.provider.hoverAt(position);
  }
}

function assertNonEmpty(name: string, value: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
}

function assertPosition(position: DocumentPosition): void {
  assertNonEmpty("file", position.file);
  if (!Number.isInteger(position.line) || position.line < 1) {
    throw new Error("line must be a positive integer");
  }
  if (!Number.isInteger(position.character) || position.character < 1) {
    throw new Error("character must be a positive integer");
  }
}
