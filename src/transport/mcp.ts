import { createRequire } from "node:module";
import { stderr, stdin as input, stdout as output } from "node:process";
import type { CommandService, WorkspaceCommandService } from "../core/command-service.js";
import { createDisposalDeadline, type DisposalDeadline, type ProcessTerminationResult } from "../core/process-ownership.js";
import { McpLifecycleCoordinator, type McpLifecycleReasonCode, type McpLifecycleResult } from "./mcp-lifecycle.js";
import { resolvePathInsideWorkspaceRootSync, shouldSelectWorkspaceService } from "../core/workspace-root.js";
import { filePathToUri } from "../utils/uri.js";

type LspCommandService = CommandService | WorkspaceCommandService;

const require = createRequire(import.meta.url);
const packageMetadata = require("../../package.json") as { version?: unknown };
const serverVersion = typeof packageMetadata.version === "string" ? packageMetadata.version : "unknown";

/** Maximum UTF-8 bytes accepted for one newline-delimited MCP request. */
export const maxMcpInputLineBytes = 1024 * 1024;
/** Maximum number of MCP request handlers that may be active at once. */
export const maxMcpInFlightRequests = 64;
/** Maximum serialized MCP response size and queued response writes. */
export const maxMcpOutputLineBytes = 16 * 1024 * 1024;
export const maxMcpPendingOutputWrites = 128;
/** Hard directory-diagnostics bounds accepted at the MCP boundary. */
export const maxDirectoryDiagnosticFiles = 1000;
export const maxDirectoryDiagnosticTimeoutBudgetMs = 120_000;
export const maxDirectoryDiagnosticConcurrency = 16;
const mcpOutputFlushTimeoutMs = 5000;

export interface McpRuntime {
  status?: () => unknown;
  directoryDiagnostics?: (request: {
    dir: string;
    severity?: string;
    root?: string;
    maxFiles?: number;
    timeoutBudgetMs?: number;
    concurrency?: number;
  }) => Promise<unknown>;
  serviceForParams?: (params: Record<string, unknown>) => LspCommandService;
  dispose?: (deadline: DisposalDeadline) => Promise<ProcessTerminationResult | void>;
  lifecycle?: McpLifecycleCoordinator;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  errorOutput?: NodeJS.WritableStream;
  setExitCode?: (code: number) => void;
  /** Suspend bridge-owned LSP resources after this many milliseconds without input. */
  idleTimeoutMs?: number;
  /** Suspend bridge-owned LSP resources while keeping the MCP stdio connection open. */
  suspend?: (deadline: DisposalDeadline) => Promise<ProcessTerminationResult | void>;
  /** Optional lower bound for the MCP input-line limit, primarily for embedding/tests. */
  maxInputLineBytes?: number;
  /** Optional lower bound for the MCP in-flight request limit, primarily for embedding/tests. */
  maxInFlightRequests?: number;
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

export const mcpTools = [
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
        root: { type: "string", description: "Optional workspace root. Absolute targets auto-detect the nearest recognized root." },
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
    description:
      "Find the semantic definition. Prefer file, line, and character when the occurrence is known; symbol-only lookup can be ambiguous.",
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
        root: { type: "string", description: "Optional workspace root. Absolute targets auto-detect the nearest recognized root." },
        line: { type: "number" },
        character: { type: "number" }
      },
      additionalProperties: false
    }
  },
  {
    name: "lsp_references",
    description:
      "Find semantic references. Prefer file, line, and character when the occurrence is known; symbol-only lookup can be ambiguous.",
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
        root: { type: "string", description: "Optional workspace root. Absolute targets auto-detect the nearest recognized root." },
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
        root: { type: "string", description: "Optional workspace root. Absolute targets auto-detect the nearest recognized root." }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "lsp_hover",
    description:
      "Return hover/type information. Prefer file, line, and character when the occurrence is known; symbol-only lookup can be ambiguous.",
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
        root: { type: "string", description: "Optional workspace root. Absolute targets auto-detect the nearest recognized root." },
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

export async function runStdioMcp(service: LspCommandService, runtime: McpRuntime = {}): Promise<McpLifecycleResult> {
  const outputStream = runtime.output ?? output;
  const errorOutput = runtime.errorOutput ?? stderr;
  const lifecycle = runtime.lifecycle ?? new McpLifecycleCoordinator({ dispose: runtime.dispose });
  const inputStream = runtime.input ?? input;
  const inputLineLimit = normalizeMcpLimit(runtime.maxInputLineBytes, maxMcpInputLineBytes);
  const inFlightLimit = normalizeMcpLimit(runtime.maxInFlightRequests, maxMcpInFlightRequests);
  const idleTimeoutMs = normalizeIdleTimeoutMs(runtime.idleTimeoutMs);
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let idleClosePending = false;
  let idleCloseRequested = false;
  let idleSuspendPending = false;
  let idleSuspensionPromise: Promise<ProcessTerminationResult | void> | undefined;
  const idleSuspensionFailures: McpLifecycleReasonCode[] = [];
  let transportClosed = false;
  let inputReaderClosedFlag = false;
  let inputLineChunks: Buffer[] = [];
  let inputLineBytes = 0;
  let discardingOversizedInputLine = false;
  let resolveInputReaderClosed: (() => void) | undefined;
  let outputWriteChain = Promise.resolve();
  let pendingOutputWrites = 0;
  let inputError: Error | undefined;
  let dispatchFailure: unknown;
  let dispatchLine: (line: string) => void = () => undefined;

  const inputReaderClosed = new Promise<void>((resolve) => {
    resolveInputReaderClosed = resolve;
  });

  const queueMcpLine = (line: string): Promise<void> => {
    if (Buffer.byteLength(line, "utf8") > maxMcpOutputLineBytes) {
      return Promise.reject(new Error(`MCP output line exceeded ${maxMcpOutputLineBytes} bytes`));
    }
    if (pendingOutputWrites >= maxMcpPendingOutputWrites) {
      return Promise.reject(new Error(`MCP output queue exceeded ${maxMcpPendingOutputWrites} pending writes`));
    }
    pendingOutputWrites += 1;
    const write = outputWriteChain
      .then(() => writeMcpLine(outputStream, line))
      .finally(() => {
        pendingOutputWrites -= 1;
      });
    outputWriteChain = write.catch(() => undefined);
    return write;
  };

  const clearIdleTimer = () => {
    if (idleTimer === undefined) return;
    clearTimeout(idleTimer);
    idleTimer = undefined;
  };
  const beginTransportClose = () => {
    transportClosed = true;
    clearIdleTimer();
    idleClosePending = false;
    idleSuspendPending = false;
  };
  const closeInputReader = () => {
    if (inputReaderClosedFlag) return;
    inputReaderClosedFlag = true;
    inputStream.removeListener("data", onInputData);
    inputStream.removeListener("end", onInputEnd);
    inputStream.removeListener("close", onInputClose);
    inputStream.removeListener("error", onInputError);
    const pausable = inputStream as NodeJS.ReadableStream & { pause?: () => void };
    pausable.pause?.();
    resolveInputReaderClosed?.();
  };
  const reportOversizedInputLine = () => {
    const response: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32600,
        message: "MCP request line exceeds configured maximum"
      }
    };
    void queueMcpLine(JSON.stringify(response)).catch((error) => {
      dispatchFailure ??= error;
      beginTransportClose();
      closeInputReader();
    });
  };
  const onInputData = (chunk: unknown) => {
    if (inputReaderClosedFlag) return;
    processInputChunk(toInputBuffer(chunk), inputLineLimit, dispatchLine, reportOversizedInputLine, {
      get chunks() {
        return inputLineChunks;
      },
      set chunks(value: Buffer[]) {
        inputLineChunks = value;
      },
      get bytes() {
        return inputLineBytes;
      },
      set bytes(value: number) {
        inputLineBytes = value;
      },
      get discarding() {
        return discardingOversizedInputLine;
      },
      set discarding(value: boolean) {
        discardingOversizedInputLine = value;
      }
    });
  };
  const onInputEnd = () => {
    if (inputReaderClosedFlag) return;
    if (!discardingOversizedInputLine && inputLineBytes > 0) {
      const line = Buffer.concat(inputLineChunks, inputLineBytes).toString("utf8");
      inputLineChunks = [];
      inputLineBytes = 0;
      dispatchLine(line);
    }
    inputLineChunks = [];
    inputLineBytes = 0;
    beginTransportClose();
    closeInputReader();
  };
  const onInputClose = () => {
    if (inputReaderClosedFlag) return;
    beginTransportClose();
    closeInputReader();
  };
  const onInputError = (cause: unknown) => {
    if (inputReaderClosedFlag) return;
    inputError = cause instanceof Error ? cause : new Error(String(cause));
    beginTransportClose();
    closeInputReader();
  };
  const closeWhenIdle = () => {
    if (idleCloseRequested) return;
    if (lifecycle.activeRequestCount > 0) {
      idleClosePending = true;
      return;
    }
    idleCloseRequested = true;
    beginTransportClose();
    errorOutput.write(`MCP connection idle for ${idleTimeoutMs}ms; closing.\n`);
    closeInputReader();
  };
  const suspendWhenIdle = () => {
    if (!runtime.suspend || idleSuspensionPromise || transportClosed || lifecycle.state !== "open") return;
    idleSuspendPending = false;
    clearIdleTimer();
    const suspension = Promise.resolve().then(() => runtime.suspend!(createDisposalDeadline()));
    idleSuspensionPromise = suspension
      .then(
        (result) => {
          if (result && !result.clean) {
            idleSuspensionFailures.push(result.reasonCode, ...(result.reasonCodes ?? []));
            errorOutput.write(`MCP idle suspension ended non-cleanly: ${result.reasonCode}.\n`);
          } else {
            errorOutput.write(`MCP connection idle for ${idleTimeoutMs}ms; suspended LSP resources.\n`);
          }
          return result;
        },
        () => {
          idleSuspensionFailures.push("disposal_failed");
          errorOutput.write("MCP idle suspension failed.\n");
          return undefined;
        }
      )
      .finally(() => {
        idleSuspensionPromise = undefined;
      });
  };
  const requestIdleAction = () => {
    if (runtime.suspend) {
      if (lifecycle.activeRequestCount > 0) {
        idleSuspendPending = true;
        return;
      }
      suspendWhenIdle();
      return;
    }
    closeWhenIdle();
  };
  const armIdleTimer = () => {
    if (idleTimeoutMs === undefined || idleCloseRequested) return;
    clearIdleTimer();
    idleClosePending = false;
    idleSuspendPending = false;
    idleTimer = setTimeout(requestIdleAction, idleTimeoutMs);
  };
  const closeAfterPendingIdleTimeout = () => {
    if (transportClosed || lifecycle.state !== "open" || lifecycle.activeRequestCount > 0) return;
    if (runtime.suspend) {
      if (idleSuspendPending) suspendWhenIdle();
      return;
    }
    if (idleClosePending) closeWhenIdle();
  };

  armIdleTimer();

  dispatchLine = (line: string) => {
    if (line.trim().length === 0) return;
    armIdleTimer();
    const suspensionToAwait = idleSuspensionPromise;
    const dispatchPromise =
      lifecycle.activeRequestCount >= inFlightLimit
        ? Promise.resolve<JsonRpcResponse | undefined>({
            jsonrpc: "2.0",
            id: null,
            error: {
              code: -32000,
              message: `MCP in-flight request limit of ${inFlightLimit} exceeded`
            }
          }).then((response) => queueMcpLine(JSON.stringify(response)).then(() => response))
        : lifecycle.dispatch(async () => {
            if (suspensionToAwait) await suspensionToAwait;
            const response = await handleJsonRpcLine(service, line, runtime);
            if (response) await queueMcpLine(JSON.stringify(response));
            return response;
          });
    void dispatchPromise.then(
      () => closeAfterPendingIdleTimeout(),
      (error) => {
        dispatchFailure ??= error;
        beginTransportClose();
        closeInputReader();
        closeAfterPendingIdleTimeout();
      }
    );
  };

  inputStream.on("data", onInputData);
  inputStream.once("end", onInputEnd);
  inputStream.once("close", onInputClose);
  inputStream.once("error", onInputError);

  try {
    await inputReaderClosed;
  } finally {
    beginTransportClose();
    closeInputReader();
  }
  const lifecycleResult = await lifecycle.close();
  if (!(await settlesBeforeTimeout(outputWriteChain, mcpOutputFlushTimeoutMs))) {
    dispatchFailure ??= new Error("MCP output flush timed out");
  }
  const suspensionCleanupPending = idleSuspensionPromise !== undefined;
  const reasonCodes = [
    ...new Set([
      ...(lifecycleResult.reasonCodes ?? (lifecycleResult.reasonCode ? [lifecycleResult.reasonCode] : [])),
      ...idleSuspensionFailures,
      ...(suspensionCleanupPending ? ["disposal_timeout" as const] : [])
    ])
  ];
  let result: McpLifecycleResult =
    reasonCodes.length === 0
      ? lifecycleResult
      : {
          ...lifecycleResult,
          state: "non_clean",
          clean: false,
          reasonCode: reasonCodes[0],
          ...(reasonCodes.length > 1 ? { reasonCodes } : {}),
          ...(lifecycleResult.cleanupPending || suspensionCleanupPending ? { cleanupPending: true } : {})
        };
  if (inputError) dispatchFailure ??= new Error("MCP input stream failed");
  if (dispatchFailure) {
    const transportReasonCodes = [
      ...new Set([...(result.reasonCodes ?? (result.reasonCode ? [result.reasonCode] : [])), "transport_failed" as const])
    ];
    result = {
      ...result,
      state: "non_clean",
      clean: false,
      reasonCode: transportReasonCodes[0],
      ...(transportReasonCodes.length > 1 ? { reasonCodes: transportReasonCodes } : {})
    };
  }
  if (dispatchFailure || !result.clean) {
    const reason = result.reasonCode ?? "dispatch_failed";
    errorOutput.write(`MCP lifecycle ended non-cleanly: ${reason}\n`);
    runtime.setExitCode?.(1);
  }
  return result;
}

function normalizeIdleTimeoutMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647 ? value : undefined;
}

function normalizeMcpLimit(value: unknown, defaultValue: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return defaultValue;
  return Math.min(value, defaultValue);
}

interface InputLineBufferState {
  chunks: Buffer[];
  bytes: number;
  discarding: boolean;
}

function processInputChunk(
  chunk: Buffer,
  maxLineBytes: number,
  onLine: (line: string) => void,
  onOversizedLine: () => void,
  state: InputLineBufferState
): void {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const newlineOffset = chunk.indexOf(0x0a, offset);
    const segmentEnd = newlineOffset === -1 ? chunk.byteLength : newlineOffset;
    const segment = chunk.subarray(offset, segmentEnd);

    if (state.discarding) {
      if (newlineOffset === -1) return;
      state.discarding = false;
      state.chunks = [];
      state.bytes = 0;
      offset = segmentEnd + 1;
      continue;
    }

    if (state.bytes + segment.byteLength > maxLineBytes) {
      state.chunks = [];
      state.bytes = 0;
      state.discarding = newlineOffset === -1;
      onOversizedLine();
      if (newlineOffset === -1) return;
      offset = segmentEnd + 1;
      continue;
    }

    if (segment.byteLength > 0) {
      state.chunks.push(Buffer.from(segment));
      state.bytes += segment.byteLength;
    }
    if (newlineOffset === -1) return;
    const line = Buffer.concat(state.chunks, state.bytes).toString("utf8").replace(/\r$/, "");
    state.chunks = [];
    state.bytes = 0;
    offset = segmentEnd + 1;
    onLine(line);
  }
}

function toInputBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk), "utf8");
}

async function writeMcpLine(outputStream: NodeJS.WritableStream, line: string): Promise<void> {
  if (outputStream.write(`${line}\n`)) return;
  await new Promise<void>((resolve, reject) => {
    outputStream.once("drain", resolve);
    outputStream.once("error", reject);
  });
}

export async function handleJsonRpcLine(
  service: LspCommandService,
  line: string,
  runtime: McpRuntime = {}
): Promise<JsonRpcResponse | undefined> {
  const inputLineLimit = normalizeMcpLimit(runtime.maxInputLineBytes, maxMcpInputLineBytes);
  if (Buffer.byteLength(line, "utf8") > inputLineLimit) {
    return {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32600,
        message: "MCP request line exceeds configured maximum"
      }
    };
  }
  try {
    return await handleRequest(service, JSON.parse(line) as Request, runtime);
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
        version: serverVersion
      }
    };
  }
  if (request.method === "tools/list") {
    return { tools: mcpTools };
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

async function dispatchLspMethod(
  service: LspCommandService,
  method: string | undefined,
  params: Record<string, unknown>
): Promise<unknown> {
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
    const severity = readOptionalEnum(args, "severity", ["error", "warning", "information", "hint"] as const);
    return runtime.directoryDiagnostics({
      dir: args.dir,
      severity,
      root: typeof args.root === "string" ? args.root : undefined,
      maxFiles: readOptionalBoundedPositiveInteger(args, "maxFiles", maxDirectoryDiagnosticFiles),
      timeoutBudgetMs: readOptionalBoundedPositiveInteger(args, "timeoutBudgetMs", maxDirectoryDiagnosticTimeoutBudgetMs),
      concurrency: readOptionalBoundedPositiveInteger(args, "concurrency", maxDirectoryDiagnosticConcurrency)
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

function selectService(service: LspCommandService, params: Record<string, unknown>, runtime: McpRuntime): LspCommandService {
  return runtime.serviceForParams && shouldSelectWorkspaceService(params) ? runtime.serviceForParams(params) : service;
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

function readOptionalPositiveInteger(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new JsonRpcError(-32602, `${key} parameter must be a positive integer`);
  }
  return value;
}

function readOptionalBoundedPositiveInteger(params: Record<string, unknown>, key: string, maximum: number): number | undefined {
  const value = readOptionalPositiveInteger(params, key);
  if (value !== undefined && value > maximum) {
    throw new JsonRpcError(-32602, `${key} parameter must be at most ${maximum}`);
  }
  return value;
}

function settlesBeforeTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    void promise.then(
      () => finish(true),
      () => finish(true)
    );
  });
}

function readOptionalEnum<const T extends readonly string[]>(
  params: Record<string, unknown>,
  key: string,
  allowed: T
): T[number] | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new JsonRpcError(-32602, `${key} parameter must be one of: ${allowed.join(", ")}`);
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
  try {
    return resolvePathInsideWorkspaceRootSync(root, file);
  } catch (error) {
    throw new JsonRpcError(-32602, error instanceof Error ? error.message : "File is outside workspace root");
  }
}
