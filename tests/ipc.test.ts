import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CommandService } from "../src/core/command-service.js";
import { diagnosticsIpcMetadataPath, hashRoot } from "../src/transport/ipc.js";
import { startDiagnosticsIpcServer } from "../src/transport/mcp.js";
import type { DiagnosticReport, HoverInfo, Location, SemanticProvider, SymbolMatch } from "../src/core/types.js";

class EmptyProvider implements SemanticProvider {
  diagnostics(uri?: string): Promise<DiagnosticReport> {
    return Promise.resolve({
      status: "ok",
      timedOut: false,
      stale: false,
      items: uri
        ? [
            {
              file: uri,
              line: 1,
              character: 1,
              severity: "error",
              message: "from ipc"
            }
          ]
        : []
    });
  }
  definition(): Promise<Location> {
    return Promise.resolve({ file: "src/a.ts", line: 1, character: 1 });
  }
  definitionAt(): Promise<Location> {
    return Promise.resolve({ file: "src/a.ts", line: 1, character: 1 });
  }
  references(): Promise<Location[]> {
    return Promise.resolve([]);
  }
  referencesAt(): Promise<Location[]> {
    return Promise.resolve([]);
  }
  symbols(): Promise<SymbolMatch[]> {
    return Promise.resolve([]);
  }
  hover(): Promise<HoverInfo> {
    return Promise.resolve({ file: "src/a.ts", line: 1, character: 1, contents: "hover" });
  }
  hoverAt(): Promise<HoverInfo> {
    return Promise.resolve({ file: "src/a.ts", line: 1, character: 1, contents: "hover" });
  }
  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

describe("diagnostics IPC", () => {
  let rootPath = "";
  let closeServer: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (closeServer) await closeServer();
    if (rootPath) await fs.rm(rootPath, { recursive: true, force: true });
    closeServer = undefined;
    rootPath = "";
  });

  it("serves diagnostics batch requests with a root-bound handshake", async () => {
    rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-ipc-root-"));
    const service = new CommandService(new EmptyProvider());
    const server = await startDiagnosticsIpcServer(service, rootPath);
    closeServer = server.close;
    const metadata = JSON.parse(await fs.readFile(diagnosticsIpcMetadataPath(rootPath), "utf8")) as {
      endpoint: string;
      secret: string;
      rootHash: string;
      protocolVersion: number;
    };

    const response = await sendIpcRequest(metadata.endpoint, {
      protocolVersion: metadata.protocolVersion,
      rootHash: metadata.rootHash,
      secret: metadata.secret,
      root: rootPath,
      files: ["src/a.ts", "src/b.ts"]
    });

    expect(response).toMatchObject({
      ok: true,
      result: {
        status: "ok",
        total: 2,
        files: [
          { file: "src/a.ts", status: "ok", total: 1 },
          { file: "src/b.ts", status: "ok", total: 1 }
        ]
      }
    });
  });

  it("rejects requests with the wrong root hash", async () => {
    rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-ipc-root-"));
    const service = new CommandService(new EmptyProvider());
    const server = await startDiagnosticsIpcServer(service, rootPath);
    closeServer = server.close;
    const metadata = JSON.parse(await fs.readFile(diagnosticsIpcMetadataPath(rootPath), "utf8")) as {
      endpoint: string;
      secret: string;
      protocolVersion: number;
    };

    const response = await sendIpcRequest(metadata.endpoint, {
      protocolVersion: metadata.protocolVersion,
      rootHash: hashRoot(path.join(rootPath, "other")),
      secret: metadata.secret,
      files: ["src/a.ts"]
    });

    expect(response).toMatchObject({
      ok: false,
      error: { kind: "security", message: "IPC security: root hash mismatch" }
    });
  });
});

function sendIpcRequest(endpoint: string, request: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) return;
      socket.end();
      resolve(JSON.parse(buffer.slice(0, newlineIndex)));
    });
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
  });
}
