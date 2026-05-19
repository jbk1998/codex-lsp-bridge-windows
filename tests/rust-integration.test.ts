import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLanguageServerConfig } from "../src/adapters/language-config.js";
import { JsonRpcLspClient } from "../src/core/json-rpc-lsp-client.js";
import { LspSemanticProvider } from "../src/core/lsp-semantic-provider.js";
import { filePathToUri } from "../src/utils/uri.js";

const shouldRunRustAnalyzerIntegration = process.env.CODEX_LSP_RUN_RUST_ANALYZER_INTEGRATION === "1";
const hasRustAnalyzer = shouldRunRustAnalyzerIntegration && await commandExists("rust-analyzer");

describe.skipIf(!hasRustAnalyzer)("Rust language server integration", () => {
  it("round-trips diagnostics through rust-analyzer", async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-rust-fixture-"));
    const filePath = path.join(rootPath, "src", "main.rs");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      path.join(rootPath, "Cargo.toml"),
      '[package]\nname = "codex_lsp_rust_fixture"\nversion = "0.1.0"\nedition = "2021"\n'
    );
    await fs.writeFile(filePath, "fn main() {\n    let value: i32 = \"bad\";\n}\n", "utf8");

    const config = createLanguageServerConfig("rust", rootPath);
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
        items: [expect.objectContaining({ severity: "error" })]
      });

      await fs.writeFile(filePath, "fn main() {\n    let value: i32 = 1;\n    let _ = value;\n}\n", "utf8");
      await expect(provider.diagnostics(filePathToUri(filePath))).resolves.toMatchObject({
        status: "ok",
        items: []
      });
    } finally {
      await provider.dispose();
      await fs.rm(rootPath, { recursive: true, force: true });
    }
  }, 20000);
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
