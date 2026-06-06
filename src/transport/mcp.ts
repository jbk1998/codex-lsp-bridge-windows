import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { CommandService, WorkspaceCommandService } from "../core/command-service.js";
import { mergeBatchDiagnosticSummaries } from "../core/diagnostics-batch.js";
import type { DiagnosticSummary } from "../core/types.js";
import { createDiagnosticsIpcMetadata, diagnosticsIpcMetadataPath, diagnosticsIpcProtocolVersion, hashRoot } from "./ipc.js";
import { filePathToUri } from "../utils/uri.js";

type LspCommandService = CommandService | WorkspaceCommandService;

export interface McpRuntime {
  status?: () => unknown;
  directoryDiagnostics?: (request: { dir: string; severity?: string; root?: string; maxFiles?: number; timeoutBudgetMs?: number; concurrency?: number }) => Promise<unknown>;
  serviceForParams?: (params: Record<string, unknown>) => LspCommandService;
}

interface Request {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
}

interface DiagnosticsIpcRequest {
  protocolVersion?: number;
  rootHash?: string;
  secret?: string;
  files?: unknown;
  root?: unknown;
  timeoutMs?: unknown;
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
        root: { type: "string", description: "Optional workspace root for detached worktrees." },
        dir: { type: "string", description: "Optional directory path to diagnose recursively." },
        severity: { type: "string", enum: ["error", "warning", "information", "hint"] },
        timeoutMs: { type: "number", description: "Maximum wait for file diagnostics publishDiagnostics in milliseconds." },
        maxFiles: { type: "number", description: "Maximum source files to diagnose for directory scans." },
        timeoutBudgetMs: { type: "number", description: "Maximum directory diagnostics wall-clock budget in milliseconds." },
        concurrency: { type: "number", description: "Maximum concurrent file diagnostics for directory scans." }
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
        root: { type: "string", description: "Optional workspace root for detached worktrees." },
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
        root: { type: "string", description: "Optional workspace root for detached worktrees." },
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
        query: { type: "string" },
        root: { type: "string", description: "Optional workspace root for detached worktrees." }
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
        root: { type: "string", description: "Optional workspace root for detached worktrees." },
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

export async function startDiagnosticsIpcServer(
  service: LspCommandService,
  root: string,
  runtime: McpRuntime = {}
): Promise<{ close: () => Promise<void>; endpoint: string }> {
  const metadata = createDiagnosticsIpcMetadata(root);
  const metadataPath = diagnosticsIpcMetadataPath(root);
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        void handleDiagnosticsIpcLine(service, root, runtime, metadata.secret, line).then((response) => {
          socket.write(`${JSON.stringify(response)}\n`);
        });
        newlineIndex = buffer.indexOf("\n");
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(metadata.endpoint, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await fs.writeFile(metadataPath, JSON.stringify(metadata), "utf8");

  return {
    endpoint: metadata.endpoint,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(metadataPath, { force: true });
    }
  };
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

  return dispatchLspMethod(selectService(service, params, runtime), request.method, params);
}

async function dispatchLspMethod(service: LspCommandService, method: string | undefined, params: Record<string, unknown>): Promise<unknown> {
  const normalizedParams = normalizeFileParams(params);
  if (method === "lsp.diagnostics") {
    if (typeof normalizedParams.dir === "string") {
      throw new JsonRpcError(-32602, "directory diagnostics require tools/call runtime support");
    }
    const options = { timeoutMs: readOptionalPositiveNumber(normalizedParams, "timeoutMs") };
    if (typeof normalizedParams.file === "string") return service.diagnostics(filePathToUri(normalizedParams.file), options);
    return service.diagnostics(typeof normalizedParams.uri === "string" ? normalizedParams.uri : undefined, options);
  }
  if (method === "lsp.definition") {
    const position = readOptionalPosition(normalizedParams);
    if (position) return service.definitionAt(position);
    return service.definition(readStringParam(normalizedParams, "symbol"));
  }
  if (method === "lsp.references") {
    const position = readOptionalPosition(normalizedParams);
    if (position) return service.referencesAt(position);
    return service.references(readStringParam(normalizedParams, "symbol"));
  }
  if (method === "lsp.symbols") {
    return service.symbols(readStringParam(normalizedParams, "query"));
  }
  if (method === "lsp.hover") {
    const position = readOptionalPosition(normalizedParams);
    if (position) return service.hoverAt(position);
    return service.hover(readStringParam(normalizedParams, "symbol"));
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
    return runtime.directoryDiagnostics({
      dir: args.dir,
      severity: typeof args.severity === "string" ? args.severity : undefined,
      root: typeof args.root === "string" ? args.root : undefined,
      maxFiles: typeof args.maxFiles === "number" ? args.maxFiles : undefined,
      timeoutBudgetMs: typeof args.timeoutBudgetMs === "number" ? args.timeoutBudgetMs : undefined,
      concurrency: typeof args.concurrency === "number" ? args.concurrency : undefined
    });
  }
  if (name === "lsp_diagnostics" && args.timeoutBudgetMs !== undefined) {
    throw new JsonRpcError(-32602, "timeoutBudgetMs is only valid for directory diagnostics; use timeoutMs for file diagnostics");
  }
  const scopedService = selectService(service, args, runtime);
  if (name === "lsp_diagnostics") return dispatchLspMethod(scopedService, "lsp.diagnostics", args);
  if (name === "lsp_definition") return dispatchLspMethod(scopedService, "lsp.definition", args);
  if (name === "lsp_references") return dispatchLspMethod(scopedService, "lsp.references", args);
  if (name === "lsp_symbols") return dispatchLspMethod(scopedService, "lsp.symbols", args);
  if (name === "lsp_hover") return dispatchLspMethod(scopedService, "lsp.hover", args);
  if (name === "lsp_status") return runtime.status ? runtime.status() : { status: "unavailable" };

  throw new JsonRpcError(-32601, `Unsupported tool: ${name}`);
}

async function handleDiagnosticsIpcLine(
  service: LspCommandService,
  root: string,
  runtime: McpRuntime,
  secret: string,
  line: string
): Promise<{ ok: true; result: unknown } | { ok: false; error: { kind: "security" | "request" | "operational"; message: string } }> {
  try {
    const request = JSON.parse(line) as DiagnosticsIpcRequest;
    validateDiagnosticsIpcRequest(request, root, secret);
    const files = request.files as string[];
    const summaries: DiagnosticSummary[] = [];
    for (const file of files) {
      const response = await dispatch(
        service,
        {
          method: "tools/call",
          params: {
            name: "lsp_diagnostics",
            arguments: {
              file,
              root,
              ...(typeof request.timeoutMs === "number" ? { timeoutMs: request.timeoutMs } : {})
            }
          }
        },
        runtime
      );
      const content = response as { structuredContent?: DiagnosticSummary };
      if (!content.structuredContent) throw new Error("diagnostics response missing structuredContent");
      summaries.push(content.structuredContent);
    }
    return {
      ok: true,
      result: mergeBatchDiagnosticSummaries(files, summaries)
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: {
        kind: message.startsWith("IPC security:") ? "security" : message.startsWith("IPC request:") ? "request" : "operational",
        message
      }
    };
  }
}

function validateDiagnosticsIpcRequest(request: DiagnosticsIpcRequest, root: string, secret: string): void {
  if (request.protocolVersion !== diagnosticsIpcProtocolVersion) throw new Error("IPC security: protocol version mismatch");
  if (request.rootHash !== hashRoot(root)) throw new Error("IPC security: root hash mismatch");
  if (request.secret !== secret) throw new Error("IPC security: secret mismatch");
  if (!Array.isArray(request.files) || !request.files.every((file) => typeof file === "string")) {
    throw new Error("IPC request: files must be a string array");
  }
  if (request.root !== undefined && request.root !== root) throw new Error("IPC security: root mismatch");
  if (request.timeoutMs !== undefined && (typeof request.timeoutMs !== "number" || !Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0)) {
    throw new Error("IPC request: timeoutMs must be a positive number");
  }
}

function selectService(service: LspCommandService, params: Record<string, unknown>, runtime: McpRuntime): LspCommandService {
  return runtime.serviceForParams && typeof params.root === "string" ? runtime.serviceForParams(params) : service;
}

function readStringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string") throw new JsonRpcError(-32602, `${key} parameter is required`);
  return value;
}

function readOptionalPositiveNumber(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new JsonRpcError(-32602, `${key} parameter must be a positive number`);
  }
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

function normalizeFileParams(params: Record<string, unknown>): Record<string, unknown> {
  if (typeof params.root !== "string" || typeof params.file !== "string") return params;
  return {
    ...params,
    file: resolveFileInsideRoot(params.root, params.file)
  };
}

function resolveFileInsideRoot(root: string, file: string): string {
  const resolvedRoot = path.resolve(root);
  const filePath = path.isAbsolute(file) ? path.resolve(file) : path.resolve(resolvedRoot, file);
  const relative = path.relative(resolvedRoot, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new JsonRpcError(-32602, `File is outside workspace root: ${filePath}`);
  }
  return filePath;
}
