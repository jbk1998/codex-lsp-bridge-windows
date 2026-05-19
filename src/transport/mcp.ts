import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { CommandService } from "../core/command-service.js";

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
        uri: { type: "string", description: "Optional file:// URI to diagnose." }
      },
      additionalProperties: false
    }
  },
  {
    name: "lsp_definition",
    description: "Find the semantic definition for a symbol or a concrete file position.",
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
    description: "Find semantic references for a symbol or a concrete file position.",
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
    description: "Return hover/type information for a symbol or a concrete file position.",
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
  }
];

export async function runStdioMcp(service: CommandService): Promise<void> {
  const rl = createInterface({ input, output });

  for await (const line of rl) {
    if (line.trim().length === 0) continue;
    const request = JSON.parse(line) as Request;
    const response = await handleRequest(service, request);
    if (response) output.write(`${JSON.stringify(response)}\n`);
  }
}

export async function handleRequest(service: CommandService, request: Request): Promise<JsonRpcResponse | undefined> {
  if (request.id === undefined) {
    if (request.method === "notifications/initialized") return undefined;
    return undefined;
  }

  try {
    const result = await dispatch(service, request);
    return { jsonrpc: "2.0", id: request.id, result };
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : "Unknown error"
      }
    };
  }
}

export async function dispatch(service: CommandService, request: Request): Promise<unknown> {
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
    const result = await callTool(service, params);
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

async function dispatchLspMethod(service: CommandService, method: string | undefined, params: Record<string, unknown>): Promise<unknown> {
  if (method === "lsp.diagnostics") {
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

  throw new Error(`Unsupported method: ${method ?? "undefined"}`);
}

async function callTool(service: CommandService, params: Record<string, unknown>): Promise<unknown> {
  const name = readStringParam(params, "name");
  const argumentsValue = params.arguments ?? {};
  if (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) {
    throw new Error("arguments parameter must be an object");
  }
  const args = argumentsValue as Record<string, unknown>;

  if (name === "lsp_diagnostics") return dispatchLspMethod(service, "lsp.diagnostics", args);
  if (name === "lsp_definition") return dispatchLspMethod(service, "lsp.definition", args);
  if (name === "lsp_references") return dispatchLspMethod(service, "lsp.references", args);
  if (name === "lsp_symbols") return dispatchLspMethod(service, "lsp.symbols", args);
  if (name === "lsp_hover") return dispatchLspMethod(service, "lsp.hover", args);

  throw new Error(`Unsupported tool: ${name}`);
}

function readStringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string") throw new Error(`${key} parameter is required`);
  return value;
}

function readOptionalPosition(params: Record<string, unknown>): { file: string; line: number; character: number } | undefined {
  if (params.file === undefined && params.line === undefined && params.character === undefined) return undefined;
  if (typeof params.file !== "string") throw new Error("file parameter is required");
  if (typeof params.line !== "number") throw new Error("line parameter is required");
  if (typeof params.character !== "number") throw new Error("character parameter is required");
  return {
    file: params.file,
    line: params.line,
    character: params.character
  };
}
