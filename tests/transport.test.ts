import { describe, expect, it } from "vitest";
import { dispatch, handleJsonRpcLine, handleRequest } from "../src/transport/mcp.js";
import { CommandService } from "../src/core/command-service.js";
import type { DiagnosticReport, HoverInfo, Location, SemanticProvider, SymbolMatch } from "../src/core/types.js";

class EmptyProvider implements SemanticProvider {
  diagnostics(): Promise<DiagnosticReport> {
    return Promise.resolve({ status: "ok", timedOut: false, stale: false, items: [] });
  }
  definition(): Promise<Location> {
    return Promise.resolve({ file: "src/a.ts", line: 1, character: 1 });
  }
  definitionAt(): Promise<Location> {
    return Promise.resolve({ file: "src/position.ts", line: 2, character: 3 });
  }
  references(): Promise<Location[]> {
    return Promise.resolve([]);
  }
  referencesAt(): Promise<Location[]> {
    return Promise.resolve([{ file: "src/position.ts", line: 2, character: 3 }]);
  }
  symbols(): Promise<SymbolMatch[]> {
    return Promise.resolve([]);
  }
  hover(): Promise<HoverInfo> {
    return Promise.resolve({ file: "src/a.ts", line: 1, character: 1, contents: "hover" });
  }
  hoverAt(): Promise<HoverInfo> {
    return Promise.resolve({ file: "src/position.ts", line: 2, character: 3, contents: "position hover" });
  }
  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

describe("MCP dispatch", () => {
  it("implements the MCP initialize and tools/list handshake", async () => {
    const service = new CommandService(new EmptyProvider());

    await expect(dispatch(service, { method: "initialize" })).resolves.toMatchObject({
      capabilities: { tools: {} },
      serverInfo: { name: "codex-lsp-bridge" }
    });
    await expect(dispatch(service, { method: "tools/list" })).resolves.toMatchObject({
      tools: expect.arrayContaining([
        expect.objectContaining({
          name: "lsp_diagnostics",
          annotations: expect.objectContaining({ readOnlyHint: true, destructiveHint: false })
        }),
        expect.objectContaining({ name: "lsp_definition" }),
        expect.objectContaining({ name: "lsp_references" }),
        expect.objectContaining({ name: "lsp_symbols" }),
        expect.objectContaining({ name: "lsp_hover" }),
        expect.objectContaining({ name: "lsp_status" })
      ])
    });
  });

  it("routes supported lsp methods", async () => {
    const service = new CommandService(new EmptyProvider());

    await expect(dispatch(service, { method: "lsp.diagnostics" })).resolves.toMatchObject({ total: 0 });
    await expect(dispatch(service, { method: "lsp.definition", params: { symbol: "Editor" } })).resolves.toMatchObject({
      file: "src/a.ts"
    });
    await expect(
      dispatch(service, { method: "lsp.definition", params: { file: "src/index.ts", line: 2, character: 10 } })
    ).resolves.toMatchObject({
      file: "src/position.ts"
    });
  });

  it("routes MCP tools/call requests to the canonical LSP command handlers", async () => {
    const service = new CommandService(new EmptyProvider());

    await expect(
      dispatch(service, { method: "tools/call", params: { name: "lsp_symbols", arguments: { query: "Editor" } } })
    ).resolves.toMatchObject({
      content: [{ type: "text" }],
      structuredContent: []
    });
    await expect(
      dispatch(service, {
        method: "tools/call",
        params: { name: "lsp_definition", arguments: { file: "src/index.ts", line: 2, character: 10 } }
      })
    ).resolves.toMatchObject({
      structuredContent: { file: "src/position.ts" }
    });
    await expect(
      dispatch(service, { method: "tools/call", params: { name: "lsp_status", arguments: {} } }, { status: () => ({ ok: true }) })
    ).resolves.toMatchObject({
      structuredContent: { ok: true }
    });
  });

  it("formats JSON-RPC responses and ignores notifications", async () => {
    const service = new CommandService(new EmptyProvider());

    await expect(handleRequest(service, { method: "notifications/initialized" })).resolves.toBeUndefined();
    await expect(handleRequest(service, { id: 1, method: "initialize" })).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { serverInfo: { name: "codex-lsp-bridge" } }
    });
    await expect(handleRequest(service, { id: "bad", method: "tools/call", params: { name: "missing" } })).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: "bad",
      error: { code: -32601, message: "Unsupported tool: missing" }
    });
    await expect(handleJsonRpcLine(service, "{bad json")).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" }
    });
    await expect(handleRequest(service, { id: 2, method: "lsp.hover", params: {} })).resolves.toMatchObject({
      error: { code: -32602, message: "symbol parameter is required" }
    });
  });

  it("fails closed for unsupported methods and missing parameters", async () => {
    const service = new CommandService(new EmptyProvider());

    await expect(dispatch(service, { method: "unknown" })).rejects.toThrow("Unsupported method");
    await expect(dispatch(service, { method: "lsp.hover", params: {} })).rejects.toThrow("symbol parameter is required");
    await expect(dispatch(service, { method: "lsp.hover", params: { file: "src/index.ts" } })).rejects.toThrow(
      "line parameter is required"
    );
    await expect(dispatch(service, { method: "tools/call", params: { name: "lsp_symbols", arguments: "bad" } })).rejects.toThrow(
      "arguments parameter must be an object"
    );
  });
});
