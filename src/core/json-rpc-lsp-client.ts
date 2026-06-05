import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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
  stop(): Promise<void>;
}

export class JsonRpcLspClient extends EventEmitter implements LspClient {
  private process: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void }
  >();

  constructor(private readonly config: ServerProcessConfig) {
    super();
  }

  start(): void {
    if (this.process) return;

    const prepared = prepareSpawnCommand(this.config);
    this.process = spawn(prepared.command, prepared.args, {
      cwd: this.config.cwd,
      stdio: "pipe",
      windowsVerbatimArguments: prepared.windowsVerbatimArguments
    });

    this.process.stdout.on("data", (chunk: Buffer) => this.readChunk(chunk));
    this.process.stderr.on("data", (chunk: Buffer) => {
      this.emit("stderr", chunk.toString("utf8"));
    });
    this.process.on("error", (cause) => {
      const error = new Error(`Failed to start LSP server "${this.config.command}": ${cause.message}`);
      this.rejectPending(error);
      this.process = undefined;
      this.emit("exit", { code: null, signal: null });
    });
    this.process.on("exit", (code, signal) => {
      const error = new Error(`LSP server exited with code ${code ?? "null"} signal ${signal ?? "null"}`);
      this.rejectPending(error);
      this.process = undefined;
      this.emit("exit", { code, signal });
    });
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
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
    this.start();
    this.write({ jsonrpc: "2.0", method, params });
  }

  async stop(): Promise<void> {
    const process = this.process;
    if (!process) return;

    try {
      await this.request("shutdown");
      this.notify("exit");
      await waitForExit(process, 1500);
    } finally {
      if (process.exitCode === null && !process.killed) process.kill();
      this.process = undefined;
    }
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

function waitForExit(process: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (process.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    process.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
