import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LspSemanticProvider } from "../src/core/lsp-semantic-provider.js";
import { JsonRpcLspClient } from "../src/core/json-rpc-lsp-client.js";
import type { LspClient, LspRequestOptions, ServerProcessConfig } from "../src/core/json-rpc-lsp-client.js";
import { filePathToUri } from "../src/utils/uri.js";
import { canonicalizeTargetPathSync } from "../src/core/workspace-root.js";

class FakeClient extends EventEmitter implements LspClient {
  readonly requests: Array<{ method: string; params?: unknown }> = [];
  readonly notifications: Array<{ method: string; params?: unknown }> = [];
  symbolResults: unknown[] = [];
  sourceDefinitionResult: unknown[] | null = null;
  definitionResult: unknown = null;
  referencesResult: unknown[] = [];
  hoverResult: unknown = null;
  initializeResult: unknown = {};
  diagnosticResults: unknown[] = [];
  stopped = false;
  initializeDelayMs = 0;
  initializeError: Error | undefined;
  requestFailure?: (method: string) => Error | undefined;
  diagnosticRequest?: (params: unknown, options?: LspRequestOptions) => Promise<unknown>;
  onNotify?: (method: string, params?: unknown) => void;

  request<T>(method: string, params?: unknown, options?: LspRequestOptions): Promise<T> {
    this.requests.push({ method, params });
    const requestFailure = this.requestFailure?.(method);
    if (requestFailure) return Promise.reject(requestFailure);
    if (method === "initialize") {
      if (this.initializeError) return Promise.reject(this.initializeError);
      if (this.initializeDelayMs === 0) return Promise.resolve(this.initializeResult as T);
      return new Promise<T>((resolve) => setTimeout(() => resolve(this.initializeResult as T), this.initializeDelayMs));
    }
    if (method === "textDocument/diagnostic") {
      if (this.diagnosticRequest) return this.diagnosticRequest(params, options).then((result) => result as T);
      return Promise.resolve(this.diagnosticResults.shift() as T);
    }
    if (method === "workspace/symbol") return Promise.resolve(this.symbolResults as T);
    if (method === "workspace/executeCommand" || method === "custom/textDocument/sourceDefinition") {
      return Promise.resolve(this.sourceDefinitionResult as T);
    }
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
      diagnosticsTimeoutMs: 500,
      diagnosticsStabilityMs: 5,
      clientFactory: (_config: ServerProcessConfig) => client
    });
  }

  function createNativeProvider(clientFactory: (config: ServerProcessConfig) => LspClient = () => client): LspSemanticProvider {
    client.initializeResult = { capabilities: { diagnosticProvider: { identifier: "typescript", workspaceDiagnostics: false } } };
    return new LspSemanticProvider({
      rootPath,
      languageId: "typescript",
      backend: "native",
      server: { command: "native-tsc.exe", args: ["--lsp", "--stdio"], cwd: rootPath },
      workspaceSeedFiles: ["src/editor.ts"],
      workspaceSeedExtensions: [".ts", ".tsx"],
      diagnosticsTimeoutMs: 500,
      diagnosticsStabilityMs: 5,
      inferredProjectCompilerOptions: { types: ["node"] },
      clientFactory
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

    await expect(provider.diagnostics(uri, { timeoutMs: 5_000 })).resolves.toMatchObject({
      status: "ok",
      timedOut: false,
      stale: false,
      sourceRevision: 1,
      items: [{ file: expect.any(String), line: 2, character: 3, severity: "error", message: "missing id" }]
    });
    expect(client.requests.filter((request) => request.method === "initialize")).toHaveLength(1);
    expect(client.notifications.some((notification) => notification.method === "textDocument/didOpen")).toBe(true);
    const initialize = client.requests.find((request) => request.method === "initialize");
    expect(initialize?.params).toMatchObject({
      workspaceFolders: [{ uri: filePathToUri(rootPath), name: path.basename(rootPath) }],
      capabilities: { workspace: { workspaceFolders: true } }
    });
  });

  it("uses native pull diagnostics and maps a full report without legacy TypeScript requests", async () => {
    client.diagnosticResults.push({
      kind: "full",
      resultId: "report-1",
      items: [
        {
          range: { start: { line: 1, character: 2 }, end: { line: 1, character: 4 } },
          severity: 1,
          code: 2339,
          source: "typescript",
          message: "missing property"
        }
      ]
    });
    const provider = createNativeProvider();
    const uri = filePathToUri(filePath);

    const report = await provider.diagnostics(uri);
    expect(report).toMatchObject({
      status: "ok",
      stale: false,
      sourceRevision: 1,
      items: [{ file: expect.any(String), line: 2, character: 3, severity: "error", code: 2339, message: "missing property" }]
    });
    expect(client.requests.filter((request) => request.method === "textDocument/diagnostic")).toHaveLength(1);
    const openedUri = (
      client.notifications.find((notification) => notification.method === "textDocument/didOpen")?.params as {
        textDocument: { uri: string };
      }
    ).textDocument.uri;
    const initialize = client.requests.find((request) => request.method === "initialize");
    expect(initialize?.params).toMatchObject({ capabilities: { textDocument: { diagnostic: {} } } });
    expect(client.requests.find((request) => request.method === "textDocument/diagnostic")?.params).toEqual({
      textDocument: { uri: openedUri }
    });
    expect(client.requests.some((request) => request.method === "workspace/executeCommand")).toBe(false);
    expect(client.requests.some((request) => request.method === "custom/textDocument/sourceDefinition")).toBe(false);
    expect(client.requests.some((request) => request.method === "workspace/diagnostic")).toBe(false);
    expect(report.configurationIssues).toContain(
      "Native TypeScript uses project configuration and does not support bridge-inferred TypeScript Server Protocol options"
    );
  });

  it("uses native source-definition and does not send the legacy execute-command request", async () => {
    const uri = filePathToUri(filePath);
    client.sourceDefinitionResult = [
      {
        uri,
        range: { start: { line: 0, character: 7 }, end: { line: 0, character: 13 } }
      }
    ];
    const provider = createNativeProvider();

    await expect(provider.definitionAt({ file: filePath, line: 1, character: 14 })).resolves.toMatchObject({
      file: filePath,
      line: 1,
      character: 8
    });
    expect(client.requests.some((request) => request.method === "custom/textDocument/sourceDefinition")).toBe(true);
    expect(client.requests.some((request) => request.method === "workspace/executeCommand")).toBe(false);
  });

  it("fails visibly when native initialization lacks pull-diagnostic capability", async () => {
    const provider = createNativeProvider();
    client.initializeResult = { capabilities: {} };

    await expect(provider.diagnostics(filePathToUri(filePath))).resolves.toMatchObject({
      status: "unavailable",
      stale: false,
      unavailableReason: expect.stringContaining("did not advertise textDocument/diagnostic support"),
      items: []
    });
  });

  it("reuses the cached native report and carries forward the unchanged response result id", async () => {
    client.diagnosticResults.push(
      { kind: "full", resultId: "report-1", items: [] },
      { kind: "unchanged", resultId: "report-2" },
      { kind: "unchanged", resultId: "report-3" }
    );
    const provider = createNativeProvider();
    const uri = filePathToUri(filePath);

    await expect(provider.diagnostics(uri)).resolves.toMatchObject({ status: "ok", items: [] });
    await expect(provider.diagnostics(uri)).resolves.toMatchObject({ status: "ok", stale: false, sourceRevision: 1, items: [] });
    await expect(provider.diagnostics(uri)).resolves.toMatchObject({ status: "ok", stale: false, sourceRevision: 1, items: [] });
    const openedUri = (
      client.notifications.find((notification) => notification.method === "textDocument/didOpen")?.params as {
        textDocument: { uri: string };
      }
    ).textDocument.uri;
    const requests = client.requests.filter((request) => request.method === "textDocument/diagnostic");
    expect(requests.map((request) => (request.params as { textDocument: { uri: string } }).textDocument.uri)).toEqual([
      openedUri,
      openedUri,
      openedUri
    ]);
    expect((requests[0].params as { previousResultId?: string }).previousResultId).toBeUndefined();
    expect((requests[1].params as { previousResultId?: string }).previousResultId).toBe("report-1");
    expect((requests[2].params as { previousResultId?: string }).previousResultId).toBe("report-2");
  });

  it("uses the diagnostic snapshot sent with each concurrent native pull", async () => {
    client.diagnosticResults.push({ kind: "full", resultId: "initial", items: [] });
    const provider = createNativeProvider();
    const uri = filePathToUri(filePath);
    await expect(provider.diagnostics(uri, { timeoutMs: 10000 })).resolves.toMatchObject({ status: "ok" });

    const replies: Array<(report: unknown) => void> = [];
    client.diagnosticRequest = () => new Promise((resolve) => replies.push(resolve));
    const first = provider.diagnostics(uri, { timeoutMs: 10000 });
    const second = provider.diagnostics(uri, { timeoutMs: 10000 });
    await vi.waitFor(() => expect(replies).toHaveLength(2));

    replies[0]({ kind: "unchanged", resultId: "next" });
    await expect(Promise.race([first, second])).resolves.toMatchObject({ status: "ok", stale: false });
    replies[1]({ kind: "unchanged", resultId: "also-next" });
    expect(await Promise.all([first, second])).toEqual([
      expect.objectContaining({ status: "ok", stale: false, items: [] }),
      expect.objectContaining({ status: "ok", stale: false, items: [] })
    ]);
  });

  it("returns unavailable for an unmatched unchanged native diagnostic report", async () => {
    client.diagnosticResults.push({ kind: "unchanged", resultId: "missing" });
    const provider = createNativeProvider();

    await expect(provider.diagnostics(filePathToUri(filePath))).resolves.toMatchObject({
      status: "unavailable",
      stale: true,
      unavailableReason: expect.stringContaining("without a matching cached result"),
      items: []
    });
  });

  it("cancels a native diagnostics request when its deadline expires", async () => {
    let canceled = false;
    client.diagnosticRequest = (_params, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => {
            canceled = true;
            const error = new Error("canceled");
            error.name = "AbortError";
            reject(error);
          },
          { once: true }
        );
      });
    const provider = createNativeProvider();

    await expect(provider.diagnostics(filePathToUri(filePath), { timeoutMs: 200 })).resolves.toMatchObject({
      status: "timed_out",
      timedOut: true,
      stale: true
    });
    expect(client.requests.filter((request) => request.method === "textDocument/diagnostic")).toHaveLength(1);
    expect(canceled).toBe(true);
  });

  it("discards a native report if the source changes while diagnostics are in flight", async () => {
    let calls = 0;
    let releaseFirst: ((report: unknown) => void) | undefined;
    client.diagnosticRequest = () => {
      calls += 1;
      if (calls === 1) return new Promise((resolve) => (releaseFirst = resolve));
      return Promise.resolve({ kind: "full", resultId: `report-${calls}`, items: [] });
    };
    const provider = createNativeProvider();
    const uri = filePathToUri(filePath);
    const olderCall = provider.diagnostics(uri, { timeoutMs: 1000 });
    await vi.waitFor(() => expect(releaseFirst).toBeTypeOf("function"));
    await fs.writeFile(filePath, "export const Editor = 2;\n", "utf8");
    await expect(provider.diagnostics(uri, { timeoutMs: 1000 })).resolves.toMatchObject({ status: "ok", sourceRevision: 2 });
    releaseFirst?.({
      kind: "full",
      resultId: "old-source",
      items: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          severity: 1,
          message: "obsolete diagnostic"
        }
      ]
    });

    await expect(olderCall).resolves.toMatchObject({ status: "ok", sourceRevision: 2, items: [] });
    expect(calls).toBe(3);
  });

  it("discards a native response from an exited server generation", async () => {
    const firstClient = client;
    const secondClient = new FakeClient();
    secondClient.initializeResult = { capabilities: { diagnosticProvider: { identifier: "typescript", workspaceDiagnostics: false } } };
    const currentDiagnostic = {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      severity: 1,
      message: "current generation"
    };
    secondClient.diagnosticResults.push(
      { kind: "full", resultId: "current-1", items: [currentDiagnostic] },
      { kind: "full", resultId: "current-2", items: [currentDiagnostic] }
    );
    let releaseOldResponse: ((value: unknown) => void) | undefined;
    firstClient.diagnosticRequest = () => new Promise((resolve) => (releaseOldResponse = resolve));
    const clients = [firstClient, secondClient];
    const provider = createNativeProvider(() => clients.shift()!);
    const uri = filePathToUri(filePath);
    const olderCall = provider.diagnostics(uri, { timeoutMs: 1000 });
    await vi.waitFor(() => expect(releaseOldResponse).toBeTypeOf("function"));
    firstClient.emit("exit", { code: 1, signal: null });

    await expect(provider.diagnostics(uri, { timeoutMs: 1000 })).resolves.toMatchObject({
      status: "ok",
      sourceRevision: 1,
      items: [{ message: "current generation" }]
    });
    releaseOldResponse?.({
      kind: "full",
      resultId: "old-generation",
      items: [{ ...currentDiagnostic, message: "obsolete generation" }]
    });
    await expect(olderCall).resolves.toMatchObject({
      status: "ok",
      sourceRevision: 1,
      items: [{ message: "current generation" }]
    });
    expect(clients).toHaveLength(0);
  });

  it("uses one timeout budget across slow startup and diagnostics freshness", async () => {
    const provider = createProvider();
    const uri = filePathToUri(filePath);
    client.initializeDelayMs = 250;
    let allowFreshDiagnostics = false;
    client.onNotify = (method, params) => {
      if (!allowFreshDiagnostics || (method !== "textDocument/didOpen" && method !== "textDocument/didChange")) return;
      client.emit("notification", "textDocument/publishDiagnostics", {
        uri: (params as { textDocument: { uri: string } }).textDocument.uri,
        diagnostics: []
      });
    };

    const startedAt = Date.now();
    await expect(provider.diagnostics(uri, { timeoutMs: 15 })).resolves.toMatchObject({
      status: "timed_out",
      timedOut: true,
      stale: true
    });
    expect(Date.now() - startedAt).toBeLessThan(100);

    await new Promise((resolve) => setTimeout(resolve, 1000));
    allowFreshDiagnostics = true;
    await fs.writeFile(filePath, "export const Editor = 2;\n", "utf8");
    await expect(provider.diagnostics(uri, { timeoutMs: 1000 })).resolves.toMatchObject({
      status: "ok",
      timedOut: false,
      stale: false,
      items: []
    });
  });

  it("keeps sequential diagnostics isolated between distinct roots", async () => {
    const secondRoot = path.join(rootPath, "second-root");
    const secondFile = path.join(secondRoot, "src", "other.ts");
    await fs.mkdir(path.dirname(secondFile), { recursive: true });
    await fs.writeFile(secondFile, "export const Other = 1;\n", "utf8");
    const secondClient = new FakeClient();
    const firstProvider = createProvider();
    const secondProvider = new LspSemanticProvider({
      rootPath: secondRoot,
      languageId: "typescript",
      server: { command: "typescript-language-server", args: ["--stdio"], cwd: secondRoot },
      workspaceSeedFiles: ["src/other.ts"],
      workspaceSeedExtensions: [".ts"],
      diagnosticsTimeoutMs: 500,
      diagnosticsStabilityMs: 1,
      clientFactory: () => secondClient
    });
    client.onNotify = (method, params) => {
      if (method !== "textDocument/didOpen") return;
      client.emit("notification", "textDocument/publishDiagnostics", {
        uri: (params as { textDocument: { uri: string } }).textDocument.uri,
        diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: "first root" }]
      });
    };
    secondClient.onNotify = (method, params) => {
      if (method !== "textDocument/didOpen") return;
      secondClient.emit("notification", "textDocument/publishDiagnostics", {
        uri: (params as { textDocument: { uri: string } }).textDocument.uri,
        diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: "second root" }]
      });
    };

    await expect(firstProvider.diagnostics(filePathToUri(filePath))).resolves.toMatchObject({ items: [{ message: "first root" }] });
    await expect(secondProvider.diagnostics(filePathToUri(secondFile))).resolves.toMatchObject({ items: [{ message: "second root" }] });
    await expect(firstProvider.diagnostics(filePathToUri(filePath))).resolves.toMatchObject({ items: [{ message: "first root" }] });
    await expect(secondProvider.diagnostics(filePathToUri(secondFile))).resolves.toMatchObject({ items: [{ message: "second root" }] });
  });

  it("keeps concurrent diagnostics isolated between distinct roots", async () => {
    const secondRoot = path.join(rootPath, "concurrent-root");
    const secondFile = path.join(secondRoot, "src", "other.ts");
    await fs.mkdir(path.dirname(secondFile), { recursive: true });
    await fs.writeFile(secondFile, "export const Other = 1;\n", "utf8");
    const secondClient = new FakeClient();
    const firstProvider = createProvider();
    const secondProvider = new LspSemanticProvider({
      rootPath: secondRoot,
      languageId: "typescript",
      server: { command: "typescript-language-server", args: ["--stdio"], cwd: secondRoot },
      workspaceSeedFiles: ["src/other.ts"],
      workspaceSeedExtensions: [".ts"],
      diagnosticsTimeoutMs: 500,
      diagnosticsStabilityMs: 1,
      clientFactory: () => secondClient
    });
    client.onNotify = (method, params) => {
      if (method !== "textDocument/didOpen") return;
      setTimeout(
        () =>
          client.emit("notification", "textDocument/publishDiagnostics", {
            uri: (params as { textDocument: { uri: string } }).textDocument.uri,
            diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: "first concurrent root" }]
          }),
        5
      );
    };
    secondClient.onNotify = (method, params) => {
      if (method !== "textDocument/didOpen") return;
      setTimeout(
        () =>
          secondClient.emit("notification", "textDocument/publishDiagnostics", {
            uri: (params as { textDocument: { uri: string } }).textDocument.uri,
            diagnostics: [
              { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: "second concurrent root" }
            ]
          }),
        5
      );
    };

    const [first, second] = await Promise.all([
      firstProvider.diagnostics(filePathToUri(filePath), { timeoutMs: 500 }),
      secondProvider.diagnostics(filePathToUri(secondFile), { timeoutMs: 500 })
    ]);
    expect(first).toMatchObject({ status: "ok", stale: false, items: [{ message: "first concurrent root" }] });
    expect(second).toMatchObject({ status: "ok", stale: false, items: [{ message: "second concurrent root" }] });
  });

  it("single-flights concurrent initialization and workspace opening", async () => {
    const provider = createProvider();
    client.initializeDelayMs = 20;
    client.symbolResults = [
      {
        name: "Editor",
        location: { uri: filePathToUri(filePath), range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }
      }
    ];

    await Promise.all([provider.symbols("Editor"), provider.symbols("Editor")]);

    expect(client.requests.filter((request) => request.method === "initialize")).toHaveLength(1);
    expect(client.notifications.filter((notification) => notification.method === "textDocument/didOpen")).toHaveLength(1);
  });

  it("accepts diagnostics that stabilize before the freshness waiter is registered", async () => {
    vi.useFakeTimers();
    try {
      const provider = createProvider();
      const uri = filePathToUri(filePath);
      client.onNotify = (method, params) => {
        if (method !== "textDocument/didOpen") return;
        client.emit("notification", "textDocument/publishDiagnostics", {
          uri: (params as { textDocument: { uri: string } }).textDocument.uri,
          diagnostics: []
        });
        vi.advanceTimersByTime(5);
      };

      await expect(provider.diagnostics(uri)).resolves.toMatchObject({ status: "ok", stale: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers one child generation and reopens the document manifest", async () => {
    const firstClient = client;
    const secondClient = new FakeClient();
    const clients = [firstClient, secondClient];
    firstClient.onNotify = (method, params) => {
      if (method !== "textDocument/didOpen") return;
      firstClient.emit("notification", "textDocument/publishDiagnostics", {
        uri: (params as { textDocument: { uri: string } }).textDocument.uri,
        diagnostics: []
      });
    };
    secondClient.onNotify = (method, params) => {
      if (method !== "textDocument/didOpen") return;
      secondClient.emit("notification", "textDocument/publishDiagnostics", {
        uri: (params as { textDocument: { uri: string } }).textDocument.uri,
        diagnostics: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            message: "current generation",
            source: "ts"
          }
        ]
      });
    };
    const provider = new LspSemanticProvider({
      rootPath,
      languageId: "typescript",
      server: { command: "typescript-language-server", args: ["--stdio"], cwd: rootPath },
      workspaceSeedFiles: ["src/editor.ts"],
      workspaceSeedExtensions: [".ts"],
      diagnosticsTimeoutMs: 500,
      diagnosticsStabilityMs: 1,
      clientFactory: () => clients.shift()!
    });
    const uri = filePathToUri(filePath);

    await expect(provider.diagnostics(uri)).resolves.toMatchObject({ status: "ok", stale: false });
    firstClient.emit("exit", { code: 1, signal: null });
    await expect(provider.diagnostics(uri)).resolves.toMatchObject({ status: "ok", stale: false });

    firstClient.emit("notification", "textDocument/publishDiagnostics", {
      uri,
      diagnostics: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          message: "stale generation",
          source: "ts"
        }
      ]
    });
    await expect(provider.diagnostics(uri)).resolves.toMatchObject({
      status: "ok",
      stale: false,
      items: [{ message: "current generation" }]
    });

    expect(secondClient.requests.filter((request) => request.method === "initialize")).toHaveLength(1);
    expect(secondClient.notifications.filter((notification) => notification.method === "textDocument/didOpen")).toHaveLength(1);
  });

  it("retries a request once when the client exits after initialization", async () => {
    const firstClient = client;
    const secondClient = new FakeClient();
    const clients = [firstClient, secondClient];
    const uri = filePathToUri(filePath);
    firstClient.onNotify = (method, params) => {
      if (method !== "textDocument/didOpen") return;
      firstClient.emit("notification", "textDocument/publishDiagnostics", {
        uri: (params as { textDocument: { uri: string } }).textDocument.uri,
        diagnostics: []
      });
    };
    secondClient.sourceDefinitionResult = [
      {
        uri,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
      }
    ];
    let failed = false;
    firstClient.requestFailure = (method) => {
      if (method !== "workspace/executeCommand" || failed) return undefined;
      failed = true;
      firstClient.emit("exit", { code: 1, signal: null });
      return new Error("request raced with exit");
    };

    const provider = new LspSemanticProvider({
      rootPath,
      languageId: "typescript",
      server: { command: "typescript-language-server", args: ["--stdio"], cwd: rootPath },
      workspaceSeedFiles: ["src/editor.ts"],
      workspaceSeedExtensions: [".ts"],
      diagnosticsTimeoutMs: 500,
      diagnosticsStabilityMs: 1,
      clientFactory: () => clients.shift()!
    });

    await expect(provider.diagnostics(uri)).resolves.toMatchObject({ status: "ok", stale: false });
    await expect(provider.definitionAt({ file: filePath, line: 1, character: 1 })).resolves.toMatchObject({
      file: filePath,
      line: 1,
      character: 1
    });
    expect(firstClient.requests.filter((request) => request.method === "workspace/executeCommand")).toHaveLength(1);
    expect(secondClient.requests.filter((request) => request.method === "workspace/executeCommand")).toHaveLength(1);
    expect(secondClient.notifications.filter((notification) => notification.method === "textDocument/didOpen")).toHaveLength(1);
  });

  it("returns a stable unavailable result after recovery fails without retrying the request", async () => {
    const firstClient = client;
    const failedClient = new FakeClient();
    failedClient.initializeError = new Error("initialize failed");
    const clients = [firstClient, failedClient];
    firstClient.onNotify = (method, params) => {
      if (method !== "textDocument/didOpen") return;
      firstClient.emit("notification", "textDocument/publishDiagnostics", {
        uri: (params as { textDocument: { uri: string } }).textDocument.uri,
        diagnostics: []
      });
    };
    const provider = new LspSemanticProvider({
      rootPath,
      languageId: "typescript",
      server: { command: "typescript-language-server", args: ["--stdio"], cwd: rootPath },
      workspaceSeedFiles: ["src/editor.ts"],
      workspaceSeedExtensions: [".ts"],
      diagnosticsTimeoutMs: 500,
      diagnosticsStabilityMs: 1,
      clientFactory: () => clients.shift()!
    });
    const uri = filePathToUri(filePath);

    await expect(provider.diagnostics(uri)).resolves.toMatchObject({ status: "ok", stale: false });
    firstClient.emit("exit", { code: 1, signal: null });

    await expect(provider.diagnostics(uri)).resolves.toMatchObject({
      status: "unavailable",
      stale: false,
      unavailableReason: expect.stringContaining("server_exited"),
      items: []
    });
    await expect(provider.diagnostics(uri)).resolves.toMatchObject({
      status: "unavailable",
      unavailableReason: expect.stringContaining("server_exited"),
      items: []
    });
    expect(failedClient.requests.filter((request) => request.method === "initialize")).toHaveLength(1);
    expect(clients).toHaveLength(0);
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
      const version = method === "textDocument/didOpen" ? textDocument.version : textDocument.version;
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
    await expect(provider.definitionAt({ file: filePath, line: 1, character: 14 })).rejects.toThrow("No source definition found");

    expect(client.notifications.filter((notification) => notification.method === "textDocument/didOpen")).toHaveLength(1);
    expect(client.notifications.filter((notification) => notification.method === "textDocument/didChange")).toHaveLength(1);
  });

  it("serializes concurrent document edits and preserves monotonic versions", async () => {
    const provider = createProvider();
    const uri = filePathToUri(filePath);

    client.onNotify = (method, params) => {
      if (method !== "textDocument/didOpen" && method !== "textDocument/didChange") return;
      const textDocument = (params as { textDocument: { uri: string; version: number } }).textDocument;
      if (method === "textDocument/didChange" && textDocument.version === 2) {
        fsSync.writeFileSync(filePath, "export const Editor = 1;\n", "utf8");
      }
    };

    await provider.diagnostics(uri, { timeoutMs: 1000 });
    await fs.writeFile(filePath, "export const Editor = 2;\n", "utf8");
    await Promise.all([provider.diagnostics(uri, { timeoutMs: 1000 }), provider.diagnostics(uri, { timeoutMs: 1000 })]);

    const transitions = client.notifications.filter(
      (notification) => notification.method === "textDocument/didOpen" || notification.method === "textDocument/didChange"
    );
    expect(transitions.map((notification) => (notification.params as { textDocument: { version: number } }).textDocument.version)).toEqual([
      1, 2, 3
    ]);
  });

  it("does not mark a diagnostic notification current before its stability barrier", async () => {
    const provider = new LspSemanticProvider({
      rootPath,
      languageId: "typescript",
      server: { command: "typescript-language-server", args: ["--stdio"], cwd: rootPath },
      workspaceSeedFiles: ["src/editor.ts"],
      workspaceSeedExtensions: [".ts"],
      diagnosticsTimeoutMs: 1000,
      diagnosticsStabilityMs: 500,
      clientFactory: () => client
    });
    const uri = filePathToUri(filePath);
    client.onNotify = (method, params) => {
      if (method !== "textDocument/didOpen") return;
      client.emit("notification", "textDocument/publishDiagnostics", {
        uri: (params as { textDocument: { uri: string } }).textDocument.uri,
        diagnostics: []
      });
    };

    await expect(provider.diagnostics(uri, { timeoutMs: 250 })).resolves.toMatchObject({
      status: "timed_out",
      timedOut: true,
      stale: true
    });
    await new Promise((resolve) => setTimeout(resolve, 35));
    await expect(provider.diagnostics(uri)).resolves.toMatchObject({
      status: "ok",
      timedOut: false,
      stale: false,
      sourceRevision: 1
    });
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
      diagnosticsTimeoutMs: 500,
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
      setTimeout(() => changedPublish?.(), 200);
    };

    await expect(provider.diagnostics(uri)).resolves.toMatchObject({
      status: "ok",
      stale: false,
      sourceRevision: 1,
      items: []
    });
    await fs.writeFile(filePath, "export const Editor = 2;\n", "utf8");
    await expect(provider.diagnostics(uri, { timeoutMs: 150 })).resolves.toMatchObject({
      status: "timed_out",
      timedOut: true,
      stale: true,
      items: []
    });
    await expect(provider.diagnostics(uri, { timeoutMs: 500 })).resolves.toMatchObject({
      status: "ok",
      timedOut: false,
      stale: false,
      sourceRevision: 2,
      items: []
    });
  });

  it("accepts versioned diagnostics when a dependency changes without a document edit", async () => {
    const provider = createProvider();
    const uri = filePathToUri(filePath);
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
    const assignmentError = { range, message: "assignment error" };
    let documentUri = uri;
    client.onNotify = (method, params) => {
      if (method !== "textDocument/didOpen") return;
      documentUri = (params as { textDocument: { uri: string } }).textDocument.uri;
      client.emit("notification", "textDocument/publishDiagnostics", {
        uri: documentUri,
        version: 1,
        diagnostics: [{ range, message: "missing import" }, assignmentError]
      });
    };

    try {
      await expect(provider.diagnostics(uri)).resolves.toMatchObject({
        status: "ok",
        stale: false,
        sourceRevision: 1,
        items: [{ message: "missing import" }, { message: "assignment error" }]
      });

      client.emit("notification", "textDocument/publishDiagnostics", {
        uri: documentUri,
        version: 1,
        diagnostics: [assignmentError]
      });
      await expect(provider.diagnostics(uri)).resolves.toMatchObject({
        status: "ok",
        stale: false,
        sourceRevision: 1,
        items: [{ message: "assignment error" }]
      });
    } finally {
      await provider.dispose();
    }
  });

  it("does not let an older document version replace current diagnostics", async () => {
    const provider = createProvider();
    const uri = filePathToUri(filePath);
    client.onNotify = (method, params) => {
      if (method !== "textDocument/didOpen" && method !== "textDocument/didChange") return;
      const textDocument = (params as { textDocument: { uri: string; version: number } }).textDocument;
      if (method === "textDocument/didOpen") {
        client.emit("notification", "textDocument/publishDiagnostics", { uri: textDocument.uri, version: 1, diagnostics: [] });
        setTimeout(() => {
          client.emit("notification", "textDocument/publishDiagnostics", {
            uri: textDocument.uri,
            version: 1,
            diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: "late old result" }]
          });
        }, 30);
        return;
      }
      client.emit("notification", "textDocument/publishDiagnostics", {
        uri: textDocument.uri,
        version: textDocument.version,
        diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: "fresh result" }]
      });
    };

    await expect(provider.diagnostics(uri)).resolves.toMatchObject({ status: "ok", stale: false, items: [] });
    await fs.writeFile(filePath, "export const Editor = 2;\n", "utf8");
    await expect(provider.diagnostics(uri, { timeoutMs: 500 })).resolves.toMatchObject({
      status: "ok",
      stale: false,
      items: [{ message: "fresh result" }]
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    await expect(provider.diagnostics(uri, { timeoutMs: 500 })).resolves.toMatchObject({
      status: "ok",
      stale: false,
      items: [{ message: "fresh result" }]
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

    await expect(provider.diagnostics(uri, { timeoutMs: 1000 })).resolves.toMatchObject({
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
      diagnosticsTimeoutMs: 500,
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

  it("sends LSP content read from a verified descriptor", async () => {
    const provider = createProvider();
    const uri = filePathToUri(filePath);
    const canonicalUri = filePathToUri(await fs.realpath(filePath));
    const pathRead = vi.spyOn(fs, "readFile").mockRejectedValue(new Error("path-based read should not run"));
    client.onNotify = (method, params) => {
      if (method !== "textDocument/didOpen") return;
      client.emit("notification", "textDocument/publishDiagnostics", {
        uri: (params as { textDocument: { uri: string } }).textDocument.uri,
        diagnostics: []
      });
    };

    try {
      await expect(provider.diagnostics(uri)).resolves.toMatchObject({
        status: "ok",
        timedOut: false,
        stale: false,
        items: []
      });
      expect(pathRead).not.toHaveBeenCalled();
      expect(client.notifications.find((notification) => notification.method === "textDocument/didOpen")).toMatchObject({
        params: {
          textDocument: {
            uri: canonicalUri,
            text: "export const Editor = 1;\n"
          }
        }
      });
    } finally {
      pathRead.mockRestore();
      await provider.dispose();
    }
  });

  it("rejects an LSP result location outside the provider workspace root", async () => {
    const outsideDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-result-outside-"));
    const outsidePath = path.join(outsideDirectory, "outside.ts");
    await fs.writeFile(outsidePath, "export const outside = 1;\n", "utf8");
    try {
      const provider = createProvider();
      client.sourceDefinitionResult = [
        {
          uri: filePathToUri(outsidePath),
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
        }
      ];

      await expect(provider.definitionAt({ file: filePath, line: 1, character: 1 })).rejects.toThrow("outside workspace root");
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
          uri: filePathToUri(canonicalizeTargetPathSync(await fs.realpath(filePath)))
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

  it("cancels pending diagnostics waiters during disposal", async () => {
    const provider = new LspSemanticProvider({
      rootPath,
      languageId: "typescript",
      server: { command: "typescript-language-server", args: ["--stdio"], cwd: rootPath },
      workspaceSeedFiles: ["src/editor.ts"],
      workspaceSeedExtensions: [".ts", ".tsx"],
      diagnosticsTimeoutMs: 5000,
      diagnosticsStabilityMs: 5,
      clientFactory: (_config: ServerProcessConfig) => client
    });
    const uri = filePathToUri(filePath);
    client.onNotify = (method) => {
      if (method === "textDocument/didOpen") setTimeout(() => void provider.dispose(), 0);
    };

    const startedAt = Date.now();
    await expect(provider.diagnostics(uri, { timeoutMs: 5000 })).resolves.toMatchObject({
      status: "timed_out",
      timedOut: true
    });
    expect(Date.now() - startedAt).toBeLessThan(1000);
    await provider.dispose();
  });

  it("disposes the backing client", async () => {
    const provider = createProvider();

    await provider.dispose();

    expect(client.stopped).toBe(true);
  });
});
