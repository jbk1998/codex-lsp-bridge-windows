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
    expect(summary.bySeverity.error).toBe(1);
    expect(summary.summary[0]).toContain("ERROR src/a.ts:2:1 missing id");
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
      unavailableReason: "Failed to start LSP server",
      total: 0
    });
  });
});
