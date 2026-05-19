import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number;
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

    this.process = spawn(this.config.command, this.config.args, {
      cwd: this.config.cwd,
      stdio: "pipe"
    });

    this.process.stdout.on("data", (chunk: Buffer) => this.readChunk(chunk));
    this.process.stderr.on("data", (chunk: Buffer) => {
      this.emit("stderr", chunk.toString("utf8"));
    });
    this.process.on("exit", (code, signal) => {
      const error = new Error(`LSP server exited with code ${code ?? "null"} signal ${signal ?? "null"}`);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
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
    if (!this.process) return;

    try {
      await this.request("shutdown");
      this.notify("exit");
    } finally {
      this.process.kill();
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
      if (!pending) return;

      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method) {
      this.emit("notification", message.method, message.params);
    }
  }
}
