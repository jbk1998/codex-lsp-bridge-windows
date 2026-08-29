import { summarizeConclusion } from "./diagnostics.js";
import type { DiagnosticSummary, DiagnosticStatus } from "./types.js";

export interface BatchDiagnosticFileSummary {
  file: string;
  status: DiagnosticStatus;
  timedOut: boolean;
  stale: boolean;
  total: number;
  bySeverity: DiagnosticSummary["bySeverity"];
  unavailableReason?: string;
}

export interface BatchDiagnosticSummary extends DiagnosticSummary {
  files: BatchDiagnosticFileSummary[];
  missingServers: Array<{ reason: string; count: number }>;
}

export function mergeBatchDiagnosticSummaries(files: string[], summaries: DiagnosticSummary[]): BatchDiagnosticSummary {
  const items = summaries.flatMap((summary) => summary.items);
  const status: DiagnosticStatus = summaries.some((summary) => summary.status === "timed_out")
    ? "timed_out"
    : summaries.some((summary) => summary.status === "unavailable")
      ? "unavailable"
      : "ok";
  const bySeverity = {
    error: items.filter((item) => item.severity === "error").length,
    warning: items.filter((item) => item.severity === "warning").length,
    information: items.filter((item) => item.severity === "information").length,
    hint: items.filter((item) => item.severity === "hint").length
  };
  const unavailableReason = summaries.find((summary) => summary.unavailableReason)?.unavailableReason;
  return {
    status,
    ...summarizeConclusion(status, items.length),
    timedOut: summaries.some((summary) => summary.timedOut),
    stale: summaries.some((summary) => summary.stale),
    ...(unavailableReason ? { unavailableReason } : {}),
    configurationIssues: [...new Set(summaries.flatMap((summary) => summary.configurationIssues))],
    total: items.length,
    bySeverity,
    items,
    summary: items
      .slice(0, 10)
      .map((item, index) => `${index + 1}. ${item.severity.toUpperCase()} ${item.file}:${item.line}:${item.character} ${item.message}`),
    files: files.map((file, index) => summarizeFile(file, summaries[index])),
    missingServers: summarizeMissingServers(summaries)
  };
}

function summarizeFile(file: string, summary: DiagnosticSummary): BatchDiagnosticFileSummary {
  return {
    file,
    status: summary.status,
    timedOut: summary.timedOut,
    stale: summary.stale,
    total: summary.total,
    bySeverity: summary.bySeverity,
    ...(summary.unavailableReason ? { unavailableReason: summary.unavailableReason } : {})
  };
}

function summarizeMissingServers(summaries: DiagnosticSummary[]): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>();
  for (const summary of summaries) {
    if (!summary.unavailableReason) continue;
    counts.set(summary.unavailableReason, (counts.get(summary.unavailableReason) ?? 0) + 1);
  }
  return [...counts.entries()].map(([reason, count]) => ({ reason, count }));
}
