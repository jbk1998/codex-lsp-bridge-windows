import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JsonRpcLspClient } from "../src/core/json-rpc-lsp-client.js";

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
});
