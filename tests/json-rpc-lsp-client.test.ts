import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createServerRequestResponse, JsonRpcLspClient, prepareSpawnCommand } from "../src/core/json-rpc-lsp-client.js";

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
  });
});
