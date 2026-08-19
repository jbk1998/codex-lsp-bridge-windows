import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  createDisposalDeadline,
  createProcessOwnership,
  type DisposalDeadline,
  type OwnedChildProcess,
  type ProcessOwnership,
  type ProcessTerminationResult
} from "./process-ownership.js";

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface ServerProcessConfig {
  command: string;
  args: string[];
  cwd: string;
}

export interface PreparedSpawnCommand {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

export interface LspClient {
  on(eventName: "notification", listener: (method: string, params: unknown) => void): this;
  on(eventName: "stderr", listener: (chunk: string) => void): this;
  on(eventName: "exit", listener: (event: { code: number | null; signal: NodeJS.Signals | null }) => void): this;
  request<T>(method: string, params?: unknown): Promise<T>;
  notify(method: string, params?: unknown): void;
  stop(deadline?: DisposalDeadline): Promise<ProcessTerminationResult | void>;
}

export interface JsonRpcLspClientOptions {
  spawnProcess?: typeof spawn;
  ownershipFactory?: (child: ChildProcessWithoutNullStreams, config: ServerProcessConfig, prepared: PreparedSpawnCommand) => ProcessOwnership;
}

export class JsonRpcLspClient extends EventEmitter implements LspClient {
  private process: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private closing = false;
  private stopPromise: Promise<ProcessTerminationResult | void> | undefined;
  private ownership: ProcessOwnership | undefined;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void }
  >();

  constructor(private readonly config: ServerProcessConfig, private readonly options: JsonRpcLspClientOptions = {}) {
    super();
  }

  start(): void {
    if (this.process) return;
    if (this.closing) throw new Error("LSP server is closing");

    const prepared = prepareSpawnCommand(this.config);
    const spawnProcess = this.options.spawnProcess ?? spawn;
    this.process = spawnProcess(prepared.command, prepared.args, {
      cwd: this.config.cwd,
      stdio: "pipe",
      windowsVerbatimArguments: prepared.windowsVerbatimArguments
    });
    this.ownership = this.options.ownershipFactory
      ? this.options.ownershipFactory(this.process, this.config, prepared)
      : createProcessOwnership(this.process as unknown as OwnedChildProcess, {
          wrapper: prepared.command.toLowerCase().endsWith("cmd.exe") || prepared.command.toLowerCase().endsWith("cmd")
        });

    this.process.stdout.on("data", (chunk: Buffer) => this.readChunk(chunk));
    this.process.stderr.on("data", (chunk: Buffer) => {
      this.emit("stderr", chunk.toString("utf8"));
    });
    this.process.on("error", (cause) => {
      const error = new Error(`Failed to start LSP server "${this.config.command}": ${cause.message}`);
      this.rejectPending(error);
      this.process = undefined;
      this.ownership = undefined;
      this.closing = false;
      this.emit("exit", { code: null, signal: null });
    });
    this.process.on("exit", (code, signal) => {
      const error = new Error(`LSP server exited with code ${code ?? "null"} signal ${signal ?? "null"}`);
      this.rejectPending(error);
      this.process = undefined;
      this.ownership = undefined;
      this.closing = false;
      this.emit("exit", { code, signal });
    });
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    return this.requestInternal(method, params, false);
  }

  private requestInternal<T>(method: string, params: unknown, allowClosing: boolean): Promise<T> {
    if (this.closing && !allowClosing) return Promise.reject(new Error("LSP server is closing"));
    this.start();
    const id = this.nextId++;
    const message: JsonRpcMessage = { jsonrpc: "2.0", id, method, params };

    const response = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject
      });
    });

    this.write(message);
    return response;
  }

  notify(method: string, params?: unknown): void {
    this.notifyInternal(method, params, false);
  }

  private notifyInternal(method: string, params: unknown, allowClosing: boolean): void {
    if (this.closing && !allowClosing) throw new Error("LSP server is closing");
    this.start();
    this.write({ jsonrpc: "2.0", method, params });
  }

  async stop(deadline = createDisposalDeadline()): Promise<ProcessTerminationResult | void> {
    if (this.stopPromise) return this.stopPromise;
    const process = this.process;
    const ownership = this.ownership;
    if (!process || !ownership) return undefined;

    this.closing = true;
    this.stopPromise = this.stopProcess(process, ownership, deadline);
    const result = await this.stopPromise;
    if (!this.process || process.exitCode !== null || process.signalCode !== null) this.closing = false;
    this.stopPromise = undefined;
    return result;
  }

  private async stopProcess(
    process: ChildProcessWithoutNullStreams,
    ownership: ProcessOwnership,
    deadline: DisposalDeadline
  ): Promise<ProcessTerminationResult> {
    try {
      const shutdownDeadline = Math.min(deadline.deadlineAt, Date.now() + deadline.shutdownRequestMs);
      const shutdown = this.requestInternal("shutdown", undefined, true);
      await withDeadline(shutdown, shutdownDeadline);
      this.notifyInternal("exit", undefined, true);
    } catch {
      // A language server that does not answer shutdown is handled by the owned-child boundary below.
    }
    if (process.exitCode !== null || process.signalCode !== null) {
      return { clean: true, reasonCode: "already_exited" };
    }
    return ownership.terminate(Math.min(deadline.deadlineAt, Date.now() + deadline.childExitGraceMs));
  }

  private write(message: JsonRpcMessage): void {
    if (!this.process) {
      throw new Error("LSP server process is not running");
    }

    const body = Buffer.from(JSON.stringify(message), "utf8");
    const header = Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "utf8");
    this.process.stdin.write(Buffer.concat([header, body]));
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private readChunk(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      const header = this.buffer.subarray(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        throw new Error(`Invalid LSP message header: ${header}`);
      }

      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (this.buffer.byteLength < bodyEnd) return;

      const rawBody = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
      this.buffer = this.buffer.subarray(bodyEnd);
      this.handleMessage(JSON.parse(rawBody) as JsonRpcMessage);
    }
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
        return;
      }
    }

    if (message.id !== undefined && message.method) {
      this.respondToServerRequest(message);
      return;
    }

    if (message.method) {
      this.emit("notification", message.method, message.params);
    }
  }

  private respondToServerRequest(message: JsonRpcMessage): void {
    this.write(createServerRequestResponse(message));
  }
}

export function createServerRequestResponse(message: JsonRpcMessage): JsonRpcMessage {
  if (message.method === "workspace/configuration") {
    const items = isWorkspaceConfigurationParams(message.params) ? message.params.items : [];
    return { jsonrpc: "2.0", id: message.id, result: items.map(() => ({})) };
  }

  if (message.method === "workspace/applyEdit") {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        applied: false,
        failureReason: "codex-lsp-bridge is read-only"
      }
    };
  }

  return { jsonrpc: "2.0", id: message.id, result: null };
}

export function prepareSpawnCommand(config: ServerProcessConfig, platform: NodeJS.Platform = process.platform): PreparedSpawnCommand {
  if (isNodeEntrypoint(config.command)) {
    return { command: process.execPath, args: [config.command, ...config.args] };
  }

  if (platform === "win32" && isWindowsShellShim(config.command)) {
    const npmEntrypoint = resolveNpmShimEntrypoint(config.command);
    if (npmEntrypoint) {
      return { command: process.execPath, args: [npmEntrypoint, ...config.args] };
    }

    return {
      command: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", quoteCmdCommand([config.command, ...config.args])],
      windowsVerbatimArguments: true
    };
  }

  return { command: config.command, args: config.args };
}

function isNodeEntrypoint(command: string): boolean {
  return [".js", ".cjs", ".mjs"].includes(path.extname(command).toLowerCase());
}

function isWindowsShellShim(command: string): boolean {
  const extension = path.extname(command).toLowerCase();
  return extension === ".cmd" || extension === ".bat";
}

function resolveNpmShimEntrypoint(command: string): string | undefined {
  let contents: string;
  try {
    contents = fs.readFileSync(command, "utf8");
  } catch {
    return undefined;
  }

  const match = /"%dp0%\\([^"]+\.(?:js|cjs|mjs))"/i.exec(contents);
  if (!match) return undefined;
  const entrypoint = path.join(path.dirname(command), match[1]);
  return fs.existsSync(entrypoint) ? entrypoint : undefined;
}

function quoteCmdArgument(value: string): string {
  if (/["&|<>^%]/.test(value)) {
    throw new Error(`Unsafe shell metacharacter in Windows command argument: ${value}`);
  }
  return `"${value}"`;
}

function quoteCmdCommand(values: string[]): string {
  return `"${values.map(quoteCmdArgument).join(" ")}"`;
}

function isWorkspaceConfigurationParams(value: unknown): value is { items: unknown[] } {
  if (!value || typeof value !== "object") return false;
  return Array.isArray((value as { items?: unknown }).items);
}

function withDeadline<T>(promise: Promise<T>, deadlineAt: number): Promise<T> {
  const remainingMs = Math.max(0, deadlineAt - Date.now());
  if (remainingMs === 0) return Promise.reject(new Error("deadline exceeded"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("deadline exceeded")), remainingMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
