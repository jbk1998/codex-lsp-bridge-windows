import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLanguageServerConfig } from "../src/adapters/language-config.js";
import { JsonRpcLspClient } from "../src/core/json-rpc-lsp-client.js";
import { LspSemanticProvider } from "../src/core/lsp-semantic-provider.js";
import { filePathToUri } from "../src/utils/uri.js";

const hasTypeScriptLanguageServer = await commandExists("typescript-language-server");
const hasPyrightLanguageServer = await commandExists("pyright-langserver");

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

  it("reports TypeScript syntax diagnostics", async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-ts-syntax-fixture-"));
    const filePath = path.join(rootPath, "src", "syntax.ts");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      path.join(rootPath, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "ESNext" }, include: ["src"] }),
      "utf8"
    );
    await fs.writeFile(filePath, "const broken = ;\n", "utf8");

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
    } finally {
      await provider.dispose();
      await fs.rm(rootPath, { recursive: true, force: true });
    }
  }, 15000);
});

describe.skipIf(!hasPyrightLanguageServer)("Pyright language server integration", () => {
  it("reports Python assignment type diagnostics", async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-py-fixture-"));
    const filePath = path.join(rootPath, "src", "sample.py");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      path.join(rootPath, "pyrightconfig.json"),
      JSON.stringify({ typeCheckingMode: "strict", include: ["src"] }),
      "utf8"
    );
    await fs.writeFile(filePath, "def double(value: int) -> int:\n    return value * 2\n\nresult: str = double(21)\n", "utf8");

    const config = createLanguageServerConfig("python", rootPath);
    const provider = new LspSemanticProvider({
      rootPath,
      languageId: config.languageId,
      server: config.server,
      workspaceSeedFiles: config.workspaceSeedFiles,
      workspaceSeedExtensions: config.extensions,
      diagnosticsTimeoutMs: 10000,
      clientFactory: (server) => new JsonRpcLspClient(server)
    });

    try {
      await expect(provider.diagnostics(filePathToUri(filePath))).resolves.toMatchObject({
        status: "ok",
        items: [expect.objectContaining({ severity: "error", message: expect.stringContaining("str") })]
      });
    } finally {
      await provider.dispose();
      await fs.rm(rootPath, { recursive: true, force: true });
    }
  }, 20000);
});

async function commandExists(command: string): Promise<boolean> {
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")] : [""];
  for (const directory of pathEntries) {
    for (const extension of extensions) {
      try {
        await fs.access(path.join(directory, `${command}${extension.toLowerCase()}`));
        return true;
      } catch {
        continue;
      }
    }
  }
  return false;
}
