import { describe, expect, it } from "vitest";
import { mergeBatchDiagnosticSummaries } from "../src/core/diagnostics-batch.js";
import type { DiagnosticSummary } from "../src/core/types.js";

describe("batch diagnostics", () => {
  it("merges per-file summaries into one stable batch contract", () => {
    const summaries: DiagnosticSummary[] = [
      {
        status: "ok",
        conclusion: "diagnostics_found",
        message: "LSP diagnostics were returned for this request.",
        timedOut: false,
        stale: false,
        configurationIssues: [],
        total: 1,
        bySeverity: { error: 1, warning: 0, information: 0, hint: 0 },
        items: [
          {
            file: "src/a.ts",
            line: 1,
            character: 1,
            severity: "error",
            message: "missing id"
          }
        ],
        summary: ["1. ERROR src/a.ts:1:1 missing id"]
      },
      {
        status: "timed_out",
        conclusion: "inconclusive",
        message: "Diagnostics timed out before fresh LSP results arrived; do not treat this as type-check passed.",
        timedOut: true,
        stale: false,
        configurationIssues: [],
        total: 0,
        bySeverity: { error: 0, warning: 0, information: 0, hint: 0 },
        items: [],
        summary: []
      }
    ];

    expect(mergeBatchDiagnosticSummaries(["src/a.ts", "src/b.ts"], summaries)).toMatchObject({
      status: "timed_out",
      conclusion: "inconclusive",
      timedOut: true,
      total: 1,
      bySeverity: { error: 1, warning: 0, information: 0, hint: 0 },
      files: [
        { file: "src/a.ts", status: "ok", total: 1 },
        { file: "src/b.ts", status: "timed_out", timedOut: true, total: 0 }
      ],
      missingServers: []
    });
  });

  it("summarizes unavailable language server reasons", () => {
    const summary: DiagnosticSummary = {
      status: "unavailable",
      conclusion: "unavailable",
      message: "Diagnostics are unavailable; do not treat this as type-check passed.",
      timedOut: false,
      stale: false,
      configurationIssues: [],
      unavailableReason: "Failed to start LSP server",
      total: 0,
      bySeverity: { error: 0, warning: 0, information: 0, hint: 0 },
      items: [],
      summary: []
    };

    expect(mergeBatchDiagnosticSummaries(["src/a.ts", "src/b.ts"], [summary, summary])).toMatchObject({
      status: "unavailable",
      missingServers: [{ reason: "Failed to start LSP server", count: 2 }]
    });
  });
});
