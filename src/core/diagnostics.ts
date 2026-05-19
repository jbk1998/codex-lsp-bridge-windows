import type { Diagnostic, DiagnosticReport, DiagnosticSummary, Severity } from "./types.js";

const severityRank: Record<Severity, number> = {
  error: 0,
  warning: 1,
  information: 2,
  hint: 3
};

export function sortDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort((left, right) => {
    const severityDelta = severityRank[left.severity] - severityRank[right.severity];
    if (severityDelta !== 0) return severityDelta;
    const fileDelta = left.file.localeCompare(right.file);
    if (fileDelta !== 0) return fileDelta;
    return left.line - right.line || left.character - right.character;
  });
}

export function summarizeDiagnostics(report: DiagnosticReport | Diagnostic[], limit = 10): DiagnosticSummary {
  const diagnostics = Array.isArray(report) ? report : report.items;
  const sorted = sortDiagnostics(diagnostics);
  const bySeverity: Record<Severity, number> = {
    error: 0,
    warning: 0,
    information: 0,
    hint: 0
  };

  for (const diagnostic of sorted) {
    bySeverity[diagnostic.severity] += 1;
  }

  const summary = sorted.slice(0, limit).map((diagnostic, index) => {
    const location = `${diagnostic.file}:${diagnostic.line}:${diagnostic.character}`;
    return `${index + 1}. ${diagnostic.severity.toUpperCase()} ${location} ${diagnostic.message}`;
  });

  return {
    status: Array.isArray(report) ? "ok" : report.status,
    timedOut: Array.isArray(report) ? false : report.timedOut,
    stale: Array.isArray(report) ? false : report.stale,
    unavailableReason: Array.isArray(report) ? undefined : report.unavailableReason,
    sourceRevision: Array.isArray(report) ? undefined : report.sourceRevision,
    total: sorted.length,
    bySeverity,
    items: sorted,
    summary
  };
}

export function lspSeverityToText(severity: number | undefined): Severity {
  if (severity === 1) return "error";
  if (severity === 2) return "warning";
  if (severity === 3) return "information";
  return "hint";
}
