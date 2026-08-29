import type { Diagnostic, DiagnosticConclusion, DiagnosticReport, DiagnosticSummary, DiagnosticStatus, Severity } from "./types.js";

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
  const configurationIssues = dedupe([
    ...(Array.isArray(report) ? [] : (report.configurationIssues ?? [])),
    ...sorted
      .filter(isMissingNodeTypeDiagnostic)
      .map(
        () =>
          "TypeScript could not resolve a Node built-in type; this is a language-environment/configuration issue, not a source-code diagnostic."
      )
  ]);
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
    ...summarizeConclusion(
      Array.isArray(report) ? "ok" : report.status,
      sorted.length,
      Array.isArray(report) ? false : report.stale,
      configurationIssues.length
    ),
    timedOut: Array.isArray(report) ? false : report.timedOut,
    stale: Array.isArray(report) ? false : report.stale,
    unavailableReason: Array.isArray(report) ? undefined : report.unavailableReason,
    configurationIssues,
    sourceRevision: Array.isArray(report) ? undefined : report.sourceRevision,
    total: sorted.length,
    bySeverity,
    items: sorted,
    summary
  };
}

export function summarizeConclusion(
  status: DiagnosticStatus,
  total: number,
  stale = false,
  configurationIssueCount = 0
): { conclusion: DiagnosticConclusion; message: string } {
  if (status === "timed_out") {
    return {
      conclusion: "inconclusive",
      message: "Diagnostics timed out before fresh LSP results arrived; do not treat this as type-check passed."
    };
  }
  if (status === "unavailable") {
    return {
      conclusion: "unavailable",
      message: "Diagnostics are unavailable; do not treat this as type-check passed."
    };
  }
  if (stale && total === 0) {
    return {
      conclusion: "inconclusive",
      message: "Diagnostics are stale or not associated with the current source revision; do not treat this empty result as clean."
    };
  }
  if (total > 0) {
    return {
      conclusion: "diagnostics_found",
      message:
        configurationIssueCount > 0
          ? "LSP diagnostics were returned, but environment/configuration issues also remain."
          : stale
            ? "LSP diagnostics were returned, but they may be stale for the current source revision."
            : "LSP diagnostics were returned for this request."
    };
  }
  if (configurationIssueCount > 0) {
    return {
      conclusion: "inconclusive",
      message: "No source diagnostics were returned, but environment/configuration issues remain; do not treat this as type-check passed."
    };
  }
  return {
    conclusion: "diagnostics_clean",
    message: "No LSP diagnostics were returned for this request (empty result); this is not a full project type-check."
  };
}

function isMissingNodeTypeDiagnostic(diagnostic: Diagnostic): boolean {
  return (diagnostic.code === 2591 || diagnostic.code === "2591") && /Cannot find (?:name|module) ['\"]node:/.test(diagnostic.message);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

export function lspSeverityToText(severity: number | undefined): Severity {
  if (severity === 1) return "error";
  if (severity === 2) return "warning";
  if (severity === 3) return "information";
  return "hint";
}
