import { describe, expect, it } from "vitest";
import { lspSeverityToText, summarizeDiagnostics } from "../src/core/diagnostics.js";

describe("diagnostics", () => {
  it("sorts high-signal diagnostics before lower severity output", () => {
    const summary = summarizeDiagnostics([
      {
        file: "src/z.ts",
        line: 10,
        character: 3,
        severity: "warning",
        message: "unused variable"
      },
      {
        file: "src/a.ts",
        line: 2,
        character: 1,
        severity: "error",
        message: "missing id"
      }
    ]);

    expect(summary.total).toBe(2);
    expect(summary.conclusion).toBe("diagnostics_found");
    expect(summary.bySeverity.error).toBe(1);
    expect(summary.summary[0]).toContain("ERROR src/a.ts:2:1 missing id");
  });

  it("marks timed out diagnostics as inconclusive instead of clean", () => {
    expect(
      summarizeDiagnostics({
        status: "timed_out",
        timedOut: true,
        stale: false,
        items: []
      })
    ).toMatchObject({
      status: "timed_out",
      conclusion: "inconclusive",
      total: 0,
      message: expect.stringContaining("do not treat this as type-check passed")
    });
  });

  it("does not claim a clean LSP diagnostics response is a full type-check", () => {
    expect(summarizeDiagnostics([])).toMatchObject({
      status: "ok",
      conclusion: "diagnostics_clean",
      total: 0,
      configurationIssues: [],
      message: expect.stringContaining("empty result")
    });
  });

  it("does not label stale empty diagnostics as clean", () => {
    expect(
      summarizeDiagnostics({
        status: "ok",
        timedOut: false,
        stale: true,
        sourceRevision: 2,
        items: []
      })
    ).toMatchObject({
      conclusion: "inconclusive",
      stale: true,
      sourceRevision: 2,
      message: expect.stringContaining("do not treat this empty result as clean")
    });
  });

  it("surfaces missing Node built-ins as configuration issues", () => {
    const summary = summarizeDiagnostics({
      status: "ok",
      timedOut: false,
      stale: false,
      sourceRevision: 1,
      items: [
        {
          file: "scripts/probe.mjs",
          line: 1,
          character: 1,
          severity: "error",
          message: "Cannot find name 'node:assert/strict'. Do you need to install type definitions for node?",
          code: 2591
        }
      ]
    });

    expect(summary.configurationIssues).toHaveLength(1);
    expect(summary.message).toContain("environment/configuration");
  });

  it("maps LSP diagnostic severities to stable text values", () => {
    expect(lspSeverityToText(1)).toBe("error");
    expect(lspSeverityToText(2)).toBe("warning");
    expect(lspSeverityToText(3)).toBe("information");
    expect(lspSeverityToText(4)).toBe("hint");
    expect(lspSeverityToText(undefined)).toBe("hint");
  });

  it("preserves unavailable diagnostics metadata", () => {
    expect(
      summarizeDiagnostics({
        status: "unavailable",
        timedOut: false,
        stale: false,
        unavailableReason: "Failed to start LSP server",
        items: []
      })
    ).toMatchObject({
      status: "unavailable",
      conclusion: "unavailable",
      unavailableReason: "Failed to start LSP server",
      total: 0
    });
  });
});
