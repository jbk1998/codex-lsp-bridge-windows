import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLanguageServerConfig } from "../src/adapters/language-config.js";
import { JsonRpcLspClient } from "../src/core/json-rpc-lsp-client.js";
import { LspSemanticProvider } from "../src/core/lsp-semantic-provider.js";
import { filePathToUri } from "../src/utils/uri.js";

const hasTypeScriptLanguageServer = await commandExists("typescript-language-server");

describe.skipIf(!hasTypeScriptLanguageServer)("TypeScript language server integration", () => {
  it("round-trips diagnostics across open, change, and clean states", async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-ts-fixture-"));
    const filePath = path.join(rootPath, "src", "index.ts");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      path.join(rootPath, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "ESNext" }, include: ["src"] }),
      "utf8"
    );
    await fs.writeFile(filePath, "const value: string = 1;\n", "utf8");

    const config = createLanguageServerConfig("typescript", rootPath);
    const provider = new LspSemanticProvider({
      rootPath,
      languageId: config.languageId,
      server: config.server,
      workspaceSeedFiles: config.workspaceSeedFiles,
      workspaceSeedExtensions: config.extensions,
      diagnosticsTimeoutMs: 5000,
      clientFactory: (server) => new JsonRpcLspClient(server)
    });

    try {
      await expect(provider.diagnostics(filePathToUri(filePath))).resolves.toMatchObject({
        status: "ok",
        items: [expect.objectContaining({ severity: "error" })]
      });

      await fs.writeFile(filePath, "const value: string = 'ok';\n", "utf8");
      await expect(provider.diagnostics(filePathToUri(filePath))).resolves.toMatchObject({
        status: "ok",
        items: []
      });
    } finally {
      await provider.dispose();
      await fs.rm(rootPath, { recursive: true, force: true });
    }
  }, 15000);
});

async function commandExists(command: string): Promise<boolean> {
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const directory of pathEntries) {
    try {
      await fs.access(path.join(directory, command));
      return true;
    } catch {
      continue;
    }
  }
  return false;
}
