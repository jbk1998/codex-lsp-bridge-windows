import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { CommandService, WorkspaceCommandService } from "../core/command-service.js";
import { filePathToUri } from "../utils/uri.js";

type LspCommandService = CommandService | WorkspaceCommandService;

interface McpRuntime {
  status?: () => unknown;
  directoryDiagnostics?: (dir: string, severity?: string) => Promise<unknown>;
}

interface Request {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message);
  }
}

const tools = [
  {
    name: "lsp_diagnostics",
    description: "Return compressed LSP diagnostics for a file or currently opened workspace documents.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    inputSchema: {
      type: "object",
      properties: {
        uri: { type: "string", description: "Optional file:// URI to diagnose." },
        file: { type: "string", description: "Optional file path to diagnose." },
        dir: { type: "string", description: "Optional directory path to diagnose recursively." },
        severity: { type: "string", enum: ["error", "warning", "information", "hint"] }
      },
      additionalProperties: false
    }
  },
  {
    name: "lsp_definition",
    description: "Find the semantic definition. Prefer file, line, and character when the occurrence is known; symbol-only lookup can be ambiguous.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        file: { type: "string" },
        line: { type: "number" },
        character: { type: "number" }
      },
      additionalProperties: false
    }
  },
  {
    name: "lsp_references",
    description: "Find semantic references. Prefer file, line, and character when the occurrence is known; symbol-only lookup can be ambiguous.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        file: { type: "string" },
        line: { type: "number" },
        character: { type: "number" }
      },
      additionalProperties: false
    }
  },
  {
    name: "lsp_symbols",
    description: "Search workspace symbols by query.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "lsp_hover",
    description: "Return hover/type information. Prefer file, line, and character when the occurrence is known; symbol-only lookup can be ambiguous.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        file: { type: "string" },
        line: { type: "number" },
        character: { type: "number" }
      },
      additionalProperties: false
    }
  },
  {
    name: "lsp_status",
    description: "Return codex-lsp-bridge status, language server availability, Codex install state, and build freshness.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  }
];

export async function runStdioMcp(service: LspCommandService, runtime: McpRuntime = {}): Promise<void> {
  const rl = createInterface({ input, output });

  for await (const line of rl) {
    if (line.trim().length === 0) continue;
    const response = await handleJsonRpcLine(service, line, runtime);
    if (response) output.write(`${JSON.stringify(response)}\n`);
  }
}

export async function handleJsonRpcLine(
  service: LspCommandService,
  line: string,
  runtime: McpRuntime = {}
): Promise<JsonRpcResponse | undefined> {
  try {
    return handleRequest(service, JSON.parse(line) as Request, runtime);
  } catch {
    return {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32700,
        message: "Parse error"
      }
    };
  }
}

export async function handleRequest(
  service: LspCommandService,
  request: Request,
  runtime: McpRuntime = {}
): Promise<JsonRpcResponse | undefined> {
  if (request.id === undefined) {
    if (request.method === "notifications/initialized") return undefined;
    return undefined;
  }

  try {
    const result = await dispatch(service, request, runtime);
    return { jsonrpc: "2.0", id: request.id, result };
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: error instanceof JsonRpcError ? error.code : -32000,
        message: error instanceof Error ? error.message : "Unknown error"
      }
    };
  }
}

export async function dispatch(service: LspCommandService, request: Request, runtime: McpRuntime = {}): Promise<unknown> {
  const params = request.params ?? {};

  if (request.method === "initialize") {
    return {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: {}
      },
      serverInfo: {
        name: "codex-lsp-bridge",
        version: "0.1.0"
      }
    };
  }
  if (request.method === "tools/list") {
    return { tools };
  }
  if (request.method === "tools/call") {
    const result = await callTool(service, params, runtime);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2)
        }
      ],
      structuredContent: result
    };
  }

  return dispatchLspMethod(service, request.method, params);
}

async function dispatchLspMethod(service: LspCommandService, method: string | undefined, params: Record<string, unknown>): Promise<unknown> {
  if (method === "lsp.diagnostics") {
    if (typeof params.dir === "string") {
      throw new JsonRpcError(-32602, "directory diagnostics require tools/call runtime support");
    }
    if (typeof params.file === "string") return service.diagnostics(filePathToUri(params.file));
    return service.diagnostics(typeof params.uri === "string" ? params.uri : undefined);
  }
  if (method === "lsp.definition") {
    const position = readOptionalPosition(params);
    if (position) return service.definitionAt(position);
    return service.definition(readStringParam(params, "symbol"));
  }
  if (method === "lsp.references") {
    const position = readOptionalPosition(params);
    if (position) return service.referencesAt(position);
    return service.references(readStringParam(params, "symbol"));
  }
  if (method === "lsp.symbols") {
    return service.symbols(readStringParam(params, "query"));
  }
  if (method === "lsp.hover") {
    const position = readOptionalPosition(params);
    if (position) return service.hoverAt(position);
    return service.hover(readStringParam(params, "symbol"));
  }

  throw new JsonRpcError(-32601, `Unsupported method: ${method ?? "undefined"}`);
}

async function callTool(service: LspCommandService, params: Record<string, unknown>, runtime: McpRuntime): Promise<unknown> {
  const name = readStringParam(params, "name");
  const argumentsValue = params.arguments ?? {};
  if (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) {
    throw new JsonRpcError(-32602, "arguments parameter must be an object");
  }
  const args = argumentsValue as Record<string, unknown>;

  if (name === "lsp_diagnostics" && typeof args.dir === "string") {
    if (!runtime.directoryDiagnostics) throw new JsonRpcError(-32602, "directory diagnostics are unavailable");
    return runtime.directoryDiagnostics(args.dir, typeof args.severity === "string" ? args.severity : undefined);
  }
  if (name === "lsp_diagnostics") return dispatchLspMethod(service, "lsp.diagnostics", args);
  if (name === "lsp_definition") return dispatchLspMethod(service, "lsp.definition", args);
  if (name === "lsp_references") return dispatchLspMethod(service, "lsp.references", args);
  if (name === "lsp_symbols") return dispatchLspMethod(service, "lsp.symbols", args);
  if (name === "lsp_hover") return dispatchLspMethod(service, "lsp.hover", args);
  if (name === "lsp_status") return runtime.status ? runtime.status() : { status: "unavailable" };

  throw new JsonRpcError(-32601, `Unsupported tool: ${name}`);
}

function readStringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string") throw new JsonRpcError(-32602, `${key} parameter is required`);
  return value;
}

function readOptionalPosition(params: Record<string, unknown>): { file: string; line: number; character: number } | undefined {
  if (params.file === undefined && params.line === undefined && params.character === undefined) return undefined;
  if (typeof params.file !== "string") throw new JsonRpcError(-32602, "file parameter is required");
  if (typeof params.line !== "number") throw new JsonRpcError(-32602, "line parameter is required");
  if (typeof params.character !== "number") throw new JsonRpcError(-32602, "character parameter is required");
  return {
    file: params.file,
    line: params.line,
    character: params.character
  };
}
