import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LspSemanticProvider } from "../src/core/lsp-semantic-provider.js";
import { JsonRpcLspClient } from "../src/core/json-rpc-lsp-client.js";
import type { LspClient, ServerProcessConfig } from "../src/core/json-rpc-lsp-client.js";
import { filePathToUri } from "../src/utils/uri.js";

class FakeClient extends EventEmitter implements LspClient {
  readonly requests: Array<{ method: string; params?: unknown }> = [];
  readonly notifications: Array<{ method: string; params?: unknown }> = [];
  symbolResults: unknown[] = [];
  sourceDefinitionResult: unknown[] | null = null;
  definitionResult: unknown = null;
  referencesResult: unknown[] = [];
  hoverResult: unknown = null;
  stopped = false;
  onNotify?: (method: string, params?: unknown) => void;

  request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (method === "initialize") return Promise.resolve({} as T);
    if (method === "workspace/symbol") return Promise.resolve(this.symbolResults as T);
    if (method === "workspace/executeCommand") return Promise.resolve(this.sourceDefinitionResult as T);
    if (method === "textDocument/definition") return Promise.resolve(this.definitionResult as T);
    if (method === "textDocument/references") return Promise.resolve(this.referencesResult as T);
    if (method === "textDocument/hover") return Promise.resolve(this.hoverResult as T);
    return Promise.resolve({} as T);
  }

  notify(method: string, params?: unknown): void {
    this.notifications.push({ method, params });
    this.onNotify?.(method, params);
  }

  stop(): Promise<void> {
    this.stopped = true;
    return Promise.resolve();
  }
}

describe("LspSemanticProvider", () => {
  let rootPath: string;
  let filePath: string;
  let client: FakeClient;

  beforeEach(async () => {
    rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-bridge-"));
    filePath = path.join(rootPath, "src", "editor.ts");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "export const Editor = 1;\n", "utf8");
    client = new FakeClient();
  });

  afterEach(async () => {
    await fs.rm(rootPath, { recursive: true, force: true });
  });

  function createProvider(): LspSemanticProvider {
    return new LspSemanticProvider({
      rootPath,
      languageId: "typescript",
      server: { command: "typescript-language-server", args: ["--stdio"], cwd: rootPath },
      workspaceSeedFiles: ["src/editor.ts"],
      workspaceSeedExtensions: [".ts", ".tsx"],
      diagnosticsTimeoutMs: 20,
      diagnosticsStabilityMs: 5,
      clientFactory: (_config: ServerProcessConfig) => client
    });
  }

  it("initializes once and captures publishDiagnostics notifications", async () => {
    const provider = createProvider();
    const uri = filePathToUri(filePath);

    client.onNotify = (method, params) => {
      if (method !== "textDocument/didOpen") return;
      const documentUri = (params as { textDocument: { uri: string } }).textDocument.uri;
      client.emit("notification", "textDocument/publishDiagnostics", {
        uri: documentUri,
        diagnostics: [
          {
            range: { start: { line: 1, character: 2 }, end: { line: 1, character: 4 } },
            severity: 1,
            message: "missing id",
            source: "ts"
          }
        ]
      });
    };

    await expect(provider.diagnostics(uri)).resolves.toMatchObject({
      status: "ok",
      timedOut: false,
      stale: false,
      sourceRevision: 1,
      items: [{ file: expect.any(String), line: 2, character: 3, severity: "error", message: "missing id" }]
    });
    expect(client.requests.filter((request) => request.method === "initialize")).toHaveLength(1);
    expect(client.notifications.some((notification) => notification.method === "textDocument/didOpen")).toBe(true);
  });

  it("matches diagnostics published with a lower-case encoded Windows drive URI", async () => {
    if (process.platform !== "win32") return;
    const provider = createProvider();
    const uri = filePathToUri(filePath);

    client.onNotify = (method, params) => {
      if (method !== "textDocument/didOpen") return;
      const documentUri = (params as { textDocument: { uri: string } }).textDocument.uri;
      const lowerDriveUri = documentUri.replace(/^file:\/\/\/([A-Z]):/, (_match, drive: string) => `file:///${drive.toLowerCase()}%3A`);
      client.emit("notification", "textDocument/publishDiagnostics", {
        uri: lowerDriveUri,
        diagnostics: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
            severity: 1,
            message: "drive key mismatch",
            source: "ts"
          }
        ]
      });
    };

    await expect(provider.diagnostics(uri)).resolves.toMatchObject({
      status: "ok",
      timedOut: false,
      items: [{ message: "drive key mismatch" }]
    });
  });

  it("waits for publishDiagnostics and tracks open document changes", async () => {
    const provider = createProvider();
    const uri = filePathToUri(filePath);

    client.onNotify = (method, params) => {
      if (method !== "textDocument/didOpen" && method !== "textDocument/didChange") return;
      const textDocument = (params as { textDocument: { uri: string; version: number } }).textDocument;
      const version =
        method === "textDocument/didOpen"
          ? textDocument.version
          : textDocument.version;
      setTimeout(() => {
        client.emit("notification", "textDocument/publishDiagnostics", {
          uri: textDocument.uri,
          diagnostics: [
            {
              range: { start: { line: version, character: 0 }, end: { line: version, character: 1 } },
              severity: 2,
              message: `version ${version}`,
              source: "ts"
            }
          ]
        });
      }, 0);
    };

    await expect(provider.diagnostics(uri)).resolves.toMatchObject({ items: [{ line: 2, message: "version 1" }] });
    await fs.writeFile(filePath, "export const Editor = 2;\n", "utf8");
    await expect(provider.diagnostics(uri)).resolves.toMatchObject({ items: [{ line: 3, message: "version 2" }] });
    await expect(provider.definitionAt({ file: filePath, line: 1, character: 14 })).rejects.toThrow(
      "No source definition found"
    );

    expect(client.notifications.filter((notification) => notification.method === "textDocument/didOpen")).toHaveLength(1);
    expect(client.notifications.filter((notification) => notification.method === "textDocument/didChange")).toHaveLength(1);
  });

  it("marks diagnostics as timed out instead of returning an indistinguishable empty success", async () => {
    const provider = createProvider();
    const uri = filePathToUri(filePath);

    await expect(provider.diagnostics(uri)).resolves.toMatchObject({
      status: "timed_out",
      timedOut: true,
      stale: true,
      sourceRevision: 1,
      items: []
    });
  });

  it("applies inferred TypeScript options before opening a standalone JavaScript file", async () => {
    const provider = new LspSemanticProvider({
      rootPath,
      languageId: "typescript",
      server: { command: "typescript-language-server", args: ["--stdio"], cwd: rootPath },
      workspaceSeedFiles: ["src/editor.ts"],
      workspaceSeedExtensions: [".ts", ".tsx"],
      diagnosticsTimeoutMs: 100,
      diagnosticsStabilityMs: 5,
      inferredProjectCompilerOptions: {
        types: ["node"],
        typeRoots: ["C:/bundled/@types"],
        allowJs: true
      },
      clientFactory: (_config: ServerProcessConfig) => client
    });

    client.onNotify = (method, params) => {
      if (method !== "textDocument/didOpen") return;
      const documentUri = (params as { textDocument: { uri: string } }).textDocument.uri;
      client.emit("notification", "textDocument/publishDiagnostics", { uri: documentUri, diagnostics: [] });
    };

    await expect(provider.diagnostics(filePathToUri(filePath))).resolves.toMatchObject({
      status: "ok",
      timedOut: false,
      stale: false,
      sourceRevision: 1
    });
    expect(client.requests).toContainEqual(
      expect.objectContaining({
        method: "workspace/executeCommand",
        params: expect.objectContaining({
          command: "typescript.tsserverRequest",
          arguments: [
            "compilerOptionsForInferredProjects",
            { options: { types: ["node"], typeRoots: ["C:/bundled/@types"], allowJs: true } },
            { expectsResult: true }
          ]
        })
      })
    );
  });

  it("keeps source revisions and stale state explicit across an edit timeout", async () => {
    const provider = createProvider();
    const uri = filePathToUri(filePath);
    let changedPublish: (() => void) | undefined;

    client.onNotify = (method, params) => {
      if (method !== "textDocument/didOpen" && method !== "textDocument/didChange") return;
      const textDocument = (params as { textDocument: { uri: string; version: number } }).textDocument;
      if (method === "textDocument/didOpen") {
        client.emit("notification", "textDocument/publishDiagnostics", { uri: textDocument.uri, diagnostics: [] });
        return;
      }
      changedPublish = () => {
        client.emit("notification", "textDocument/publishDiagnostics", { uri: textDocument.uri, diagnostics: [] });
      };
      setTimeout(() => changedPublish?.(), 35);
    };

    await expect(provider.diagnostics(uri)).resolves.toMatchObject({
      status: "ok",
      stale: false,
      sourceRevision: 1,
      items: []
    });
    await fs.writeFile(filePath, "export const Editor = 2;\n", "utf8");
    await expect(provider.diagnostics(uri, { timeoutMs: 5 })).resolves.toMatchObject({
      status: "timed_out",
      timedOut: true,
      stale: true,
      sourceRevision: 2,
      items: []
    });
    await expect(provider.diagnostics(uri, { timeoutMs: 100 })).resolves.toMatchObject({
      status: "ok",
      timedOut: false,
      stale: false,
      sourceRevision: 2,
      items: []
    });
  });

  it("allows per-call diagnostics timeout overrides", async () => {
    const provider = createProvider();
    const uri = filePathToUri(filePath);

    client.onNotify = (method, params) => {
      if (method !== "textDocument/didOpen") return;
      const documentUri = (params as { textDocument: { uri: string } }).textDocument.uri;
      setTimeout(() => {
        client.emit("notification", "textDocument/publishDiagnostics", {
          uri: documentUri,
          diagnostics: []
        });
      }, 35);
    };

    await expect(provider.diagnostics(uri, { timeoutMs: 80 })).resolves.toMatchObject({
      status: "ok",
      timedOut: false,
      items: []
    });
  });

  it("returns unavailable diagnostics when the language server command is missing", async () => {
    const provider = new LspSemanticProvider({
      rootPath,
      languageId: "typescript",
      server: { command: path.join(os.tmpdir(), "codex-lsp-missing-server"), args: [], cwd: rootPath },
      workspaceSeedFiles: ["src/editor.ts"],
      workspaceSeedExtensions: [".ts", ".tsx"],
      diagnosticsTimeoutMs: 20,
      clientFactory: (server) => new JsonRpcLspClient(server)
    });

    await expect(provider.diagnostics(filePathToUri(filePath))).resolves.toMatchObject({
      status: "unavailable",
      timedOut: false,
      stale: false,
      unavailableReason: expect.stringContaining("Failed to start LSP server"),
      items: []
    });
  });

  it("rejects files outside the workspace root and symlink escapes when Windows permits symlink creation", async () => {
    const outsideDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-outside-"));
    const outsidePath = path.join(outsideDirectory, "outside.ts");
    const symlinkPath = path.join(rootPath, "src", "linked-outside.ts");
    let symlinkCreated = false;

    try {
      await fs.writeFile(outsidePath, "export const outside = 1;\n", "utf8");
      try {
        await fs.symlink(outsidePath, symlinkPath);
        symlinkCreated = true;
      } catch (error) {
        const errorCode = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
        if (process.platform !== "win32" || errorCode !== "EPERM") throw error;
      }

      const provider = createProvider();
      await expect(provider.diagnostics(filePathToUri(outsidePath))).rejects.toThrow("outside workspace root");
      if (symlinkCreated) {
        await expect(provider.diagnostics(filePathToUri(symlinkPath))).rejects.toThrow("outside workspace root");
      }
    } finally {
      await fs.rm(outsideDirectory, { recursive: true, force: true });
    }
  });

  it("resolves definition, references, and hover through a single exact symbol", async () => {
    const provider = createProvider();
    const uri = filePathToUri(filePath);
    client.symbolResults = [
      {
        name: "Editor",
        kind: 13,
        containerName: "src",
        location: { uri, range: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } } }
      }
    ];
    client.definitionResult = { uri, range: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } } };
    client.sourceDefinitionResult = [client.definitionResult];
    client.referencesResult = [client.definitionResult];
    client.hoverResult = { contents: [{ value: "const Editor: 1" }, "readonly"] };

    await expect(provider.symbols("Editor")).resolves.toMatchObject([{ name: "Editor", line: 1, character: 14 }]);
    expect(client.notifications.filter((notification) => notification.method === "textDocument/didOpen")).toHaveLength(1);
    await expect(provider.definition("Editor")).resolves.toMatchObject({ file: filePath, line: 1, character: 14 });
    await expect(provider.definitionAt({ file: filePath, line: 1, character: 14 })).resolves.toMatchObject({
      file: filePath,
      line: 1,
      character: 14
    });
    await expect(provider.references("Editor")).resolves.toHaveLength(1);
    await expect(provider.referencesAt({ file: filePath, line: 1, character: 14 })).resolves.toHaveLength(1);
    await expect(provider.hover("Editor")).resolves.toMatchObject({ contents: "const Editor: 1\n\nreadonly" });
    await expect(provider.hoverAt({ file: filePath, line: 1, character: 14 })).resolves.toMatchObject({
      contents: "const Editor: 1\n\nreadonly"
    });
  });

  it("fails closed when workspace symbol lookup has no seed file", async () => {
    const provider = new LspSemanticProvider({
      rootPath,
      languageId: "typescript",
      server: { command: "typescript-language-server", args: ["--stdio"], cwd: rootPath },
      workspaceSeedFiles: ["src/missing.ts"],
      workspaceSeedExtensions: [],
      clientFactory: (_config: ServerProcessConfig) => client
    });

    await expect(provider.symbols("Editor")).rejects.toThrow("No typescript workspace seed file found");
  });

  it("finds a workspace seed file by extension when known seed paths are absent", async () => {
    const nestedFile = path.join(rootPath, "packages", "app", "src", "fallback.ts");
    await fs.mkdir(path.dirname(nestedFile), { recursive: true });
    await fs.writeFile(nestedFile, "export const Fallback = 1;\n", "utf8");
    client.symbolResults = [
      {
        name: "Fallback",
        location: {
          uri: filePathToUri(nestedFile),
          range: { start: { line: 0, character: 13 }, end: { line: 0, character: 21 } }
        }
      }
    ];
    const provider = new LspSemanticProvider({
      rootPath,
      languageId: "typescript",
      server: { command: "typescript-language-server", args: ["--stdio"], cwd: rootPath },
      workspaceSeedFiles: ["src/missing.ts"],
      workspaceSeedExtensions: [".ts"],
      diagnosticsTimeoutMs: 20,
      clientFactory: (_config: ServerProcessConfig) => client
    });

    await expect(provider.symbols("Fallback")).resolves.toMatchObject([{ file: nestedFile, name: "Fallback" }]);
    const didOpen = client.notifications.find((notification) => notification.method === "textDocument/didOpen");
    expect(didOpen).toMatchObject({
      params: {
        textDocument: {
          uri: filePathToUri(await fs.realpath(filePath))
        }
      }
    });
  });

  it("fails closed when symbol resolution is missing or ambiguous", async () => {
    const provider = createProvider();
    const uri = filePathToUri(filePath);

    await expect(provider.definition("Editor")).rejects.toThrow("Symbol not found");

    client.symbolResults = [
      { name: "Editor", location: { uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } } },
      { name: "Editor", location: { uri, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } } } }
    ];

    await expect(provider.definition("Editor")).rejects.toThrow("Symbol is ambiguous");
  });

  it("disposes the backing client", async () => {
    const provider = createProvider();

    await provider.dispose();

    expect(client.stopped).toBe(true);
  });
});
