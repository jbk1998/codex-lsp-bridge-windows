export type Severity = "error" | "warning" | "information" | "hint";

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Location {
  file: string;
  line: number;
  character: number;
  range?: Range;
}

export interface DocumentPosition {
  file: string;
  line: number;
  character: number;
}

export interface Diagnostic {
  file: string;
  line: number;
  character: number;
  severity: Severity;
  message: string;
  source?: string;
  code?: string | number;
}

export type DiagnosticStatus = "ok" | "timed_out";

export interface DiagnosticReport {
  status: DiagnosticStatus;
  timedOut: boolean;
  stale: boolean;
  sourceRevision?: number;
  items: Diagnostic[];
}

export interface SymbolMatch extends Location {
  name: string;
  kind?: string;
  containerName?: string;
}

export interface HoverInfo {
  file: string;
  line: number;
  character: number;
  contents: string;
}

export interface SemanticProvider {
  diagnostics(uri?: string): Promise<DiagnosticReport>;
  definition(symbol: string): Promise<Location>;
  definitionAt(position: DocumentPosition): Promise<Location>;
  references(symbol: string): Promise<Location[]>;
  referencesAt(position: DocumentPosition): Promise<Location[]>;
  symbols(query: string): Promise<SymbolMatch[]>;
  hover(symbol: string): Promise<HoverInfo>;
  hoverAt(position: DocumentPosition): Promise<HoverInfo>;
  dispose(): Promise<void>;
}

export interface DiagnosticSummary {
  status: DiagnosticStatus;
  timedOut: boolean;
  stale: boolean;
  sourceRevision?: number;
  total: number;
  bySeverity: Record<Severity, number>;
  items: Diagnostic[];
  summary: string[];
}
