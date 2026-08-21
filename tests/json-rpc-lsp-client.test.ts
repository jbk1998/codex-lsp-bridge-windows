import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createServerRequestResponse, JsonRpcLspClient, prepareSpawnCommand } from "../src/core/json-rpc-lsp-client.js";
import { createDisposalDeadline, type ProcessIdentityProvider } from "../src/core/process-ownership.js";
import { filePathToUri } from "../src/utils/uri.js";

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly pid = 42;
  exitCode: number | null = null;
  signalCode = null;
  killCalls = 0;

  kill(): boolean {
    this.killCalls += 1;
    this.exitCode = 1;
    this.emit("exit", 1, null);
    return true;
  }
}

function identityProvider(token: string | (() => string) = "launch"): ProcessIdentityProvider {
  return {
    read: (pid) => ({ pid, creationToken: typeof token === "function" ? token() : token })
  };
}

describe("JsonRpcLspClient", () => {
  it("rejects requests instead of crashing when the language server command is missing", async () => {
    const client = new JsonRpcLspClient({
      command: path.join(os.tmpdir(), "codex-lsp-missing-server"),
      args: [],
      cwd: process.cwd()
    });

    await expect(client.request("initialize")).rejects.toThrow("Failed to start LSP server");
    await expect(client.stop()).resolves.toBeUndefined();
  });

  it("prepares Windows shell shims through cmd.exe", () => {
    const prepared = prepareSpawnCommand(
      {
        command: "C:\\Program Files\\nodejs\\typescript-language-server.cmd",
        args: ["--stdio", "--log-level", "info"],
        cwd: process.cwd()
      },
      "win32"
    );

    expect(path.basename(prepared.command).toLowerCase()).toBe(path.basename(process.env.ComSpec ?? "cmd.exe").toLowerCase());
    expect(prepared.args).toEqual([
      "/d",
      "/s",
      "/c",
      "\"\"C:\\Program Files\\nodejs\\typescript-language-server.cmd\" \"--stdio\" \"--log-level\" \"info\"\""
    ]);
    expect(prepared.windowsVerbatimArguments).toBe(true);
  });

  it("bounds an unresponsive shutdown and reports observed ownership", async () => {
    const child = new FakeChild();
    const client = new JsonRpcLspClient(
      { command: "server", args: ["--stdio"], cwd: process.cwd() },
      { spawnProcess: (() => child) as never, processIdentityProvider: identityProvider() }
    );
    const initialize = client.request("initialize").catch(() => undefined);

    const result = await client.stop(createDisposalDeadline(Date.now(), 100, 5, 20));

    expect(result).toEqual({ clean: true, reasonCode: "owned_child_exit" });
    expect(child.killCalls).toBe(1);
    await initialize;
    expect((client as unknown as { pending: Map<unknown, unknown> }).pending.size).toBe(0);
    expect(child.exitCode).not.toBeNull();
  });

  it("refuses to terminate a PID whose identity changed after launch", async () => {
    const child = new FakeChild();
    let token = "launch";
    const client = new JsonRpcLspClient(
      { command: "server", args: ["--stdio"], cwd: process.cwd() },
      {
        spawnProcess: (() => child) as never,
        processIdentityProvider: identityProvider(() => token)
      }
    );
    const initialize = client.request("initialize").catch(() => undefined);
    token = "pid-reuse";

    await expect(client.stop(createDisposalDeadline(Date.now(), 100, 1, 20))).resolves.toEqual({
      clean: false,
      reasonCode: "identity_mismatch"
    });
    expect(child.killCalls).toBe(0);
  });

  it("refuses to terminate when the process identity cannot be read", async () => {
    const child = new FakeChild();
    const client = new JsonRpcLspClient(
      { command: "server", args: ["--stdio"], cwd: process.cwd() },
      {
        spawnProcess: (() => child) as never,
        processIdentityProvider: { read: () => undefined }
      }
    );
    const initialize = client.request("initialize").catch(() => undefined);

    await expect(client.stop(createDisposalDeadline(Date.now(), 100, 1, 20))).resolves.toEqual({
      clean: false,
      reasonCode: "identity_mismatch"
    });
    expect(child.killCalls).toBe(0);
  });

  it("rewrites npm Windows shims to direct Node entrypoints", async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-npm-shim-"));
    const shimPath = path.join(rootPath, "server.cmd");
    const entrypointPath = path.join(rootPath, "node_modules", "server", "lib", "cli.mjs");
    await fs.mkdir(path.dirname(entrypointPath), { recursive: true });
    await fs.writeFile(entrypointPath, "console.log('server')\n", "utf8");
    await fs.writeFile(shimPath, `"node" "%dp0%\\node_modules\\server\\lib\\cli.mjs" %*\n`, "utf8");

    try {
      expect(prepareSpawnCommand({ command: shimPath, args: ["--stdio"], cwd: process.cwd() }, "win32")).toEqual({
        command: process.execPath,
        args: [entrypointPath, "--stdio"]
      });
    } finally {
      await fs.rm(rootPath, { recursive: true, force: true });
    }
  });

  it("rejects Windows shell shim arguments with cmd metacharacters", () => {
    expect(() =>
      prepareSpawnCommand(
        {
          command: "C:\\Tools\\server.cmd",
          args: ["--stdio", "bad&arg"],
          cwd: process.cwd()
        },
        "win32"
      )
    ).toThrow("Unsafe shell metacharacter");
  });

  it("leaves Unix command preparation unchanged", () => {
    expect(prepareSpawnCommand({ command: "typescript-language-server", args: ["--stdio"], cwd: process.cwd() }, "linux")).toEqual({
      command: "typescript-language-server",
      args: ["--stdio"]
    });
  });

  it("runs direct Node entrypoints through the current Node executable", () => {
    expect(prepareSpawnCommand({ command: "C:\\Tools\\pyright-langserver.js", args: ["--stdio"], cwd: process.cwd() }, "win32")).toEqual({
      command: process.execPath,
      args: ["C:\\Tools\\pyright-langserver.js", "--stdio"]
    });
  });

  it("builds safe responses for common server-originated requests", () => {
    expect(
      createServerRequestResponse({
        jsonrpc: "2.0",
        id: "config-1",
        method: "workspace/configuration",
        params: { items: [{ section: "typescript" }, { section: "python" }] }
      })
    ).toEqual({ jsonrpc: "2.0", id: "config-1", result: [{}, {}] });

    expect(createServerRequestResponse({ jsonrpc: "2.0", id: 2, method: "workspace/applyEdit" })).toMatchObject({
      id: 2,
      result: { applied: false, failureReason: expect.stringContaining("read-only") }
    });

    expect(createServerRequestResponse({ jsonrpc: "2.0", id: 3, method: "unknown/request" })).toEqual({
      jsonrpc: "2.0",
      id: 3,
      result: null
    });

    const workspaceRoot = path.join(os.tmpdir(), "codex-lsp-workspace");
    expect(createServerRequestResponse({ jsonrpc: "2.0", id: 4, method: "workspace/workspaceFolders" }, workspaceRoot)).toEqual({
      jsonrpc: "2.0",
      id: 4,
      result: [{ uri: filePathToUri(workspaceRoot), name: path.basename(workspaceRoot) }]
    });
  });

  it("correlates string JSON-RPC response ids", async () => {
    const client = new JsonRpcLspClient({ command: "server", args: ["--stdio"], cwd: process.cwd() });
    let resolveResponse: (value: unknown) => void = () => undefined;
    let rejectResponse: (reason: Error) => void = () => undefined;
    const response = new Promise((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    const internal = client as unknown as {
      pending: Map<string, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>;
      handleMessage: (message: { jsonrpc: "2.0"; id: string; result: unknown }) => void;
    };
    internal.pending.set("string-1", { resolve: resolveResponse, reject: rejectResponse });
    internal.handleMessage({ jsonrpc: "2.0", id: "string-1", result: { ready: true } });

    await expect(response).resolves.toEqual({ ready: true });
    expect(internal.pending.size).toBe(0);
  });

  it("removes a request when writing to the child fails", async () => {
    const child = new FakeChild();
    const client = new JsonRpcLspClient(
      { command: "server", args: ["--stdio"], cwd: process.cwd() },
      { spawnProcess: (() => child) as never, processIdentityProvider: identityProvider() }
    );
    const internal = client as unknown as { pending: Map<unknown, unknown> };
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = (() => {
      throw new Error("pipe closed");
    }) as typeof child.stdin.write;

    await expect(client.request("initialize")).rejects.toThrow("pipe closed");
    expect(internal.pending.size).toBe(0);
    child.stdin.write = write;
    await client.stop(createDisposalDeadline(Date.now(), 100, 5, 20));
  });
});
