import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLanguageServerConfig } from "../src/adapters/language-config.js";
import { JsonRpcLspClient } from "../src/core/json-rpc-lsp-client.js";
import { LspSemanticProvider } from "../src/core/lsp-semantic-provider.js";
import { LspManager } from "../src/core/lsp-manager.js";
import { resolveNodeTypeRoots } from "../src/core/typescript-project.js";
import { filePathToUri } from "../src/utils/uri.js";

const hasTypeScriptLanguageServer = await commandExists("typescript-language-server");
const hasPyrightLanguageServer = await commandExists("pyright-langserver");
const hasBundledNodeTypeRoot = resolveNodeTypeRoots(path.join(os.tmpdir(), "codex-lsp-no-project"), process.execPath).length > 0;

describe.skipIf(!hasTypeScriptLanguageServer)("TypeScript language server integration", () => {
  it.skipIf(!hasBundledNodeTypeRoot)("resolves Node built-ins for a standalone .mjs skill without masking JSDoc diagnostics", async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-skill-fixture-"));
    const filePath = path.join(rootPath, "scripts", "probe.mjs");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(path.join(rootPath, "SKILL.md"), "# Standalone skill\n", "utf8");
    await fs.writeFile(
      filePath,
      "// @ts-check\nimport assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\nassert.equal(typeof readFileSync, 'function');\nconst value = 1;\nvalue.toUpperCase();\n",
      "utf8"
    );

    const manager = new LspManager(rootPath);
    try {
      const report = await manager.forFile(filePath).diagnostics(filePathToUri(filePath));
      expect(report.status).toBe("ok");
      expect(report.timedOut).toBe(false);
      expect(report.stale).toBe(false);
      expect(report.sourceRevision).toBe(1);
      expect(report.items.some((item) => item.code === 2591)).toBe(false);
      expect(report.items.some((item) => item.code === 2339)).toBe(true);
    } finally {
      await manager.dispose();
      await fs.rm(rootPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 20000);

  it.skipIf(!hasBundledNodeTypeRoot)("resolves Node built-ins without enabling unchecked JavaScript diagnostics", async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-unchecked-js-fixture-"));
    const filePath = path.join(rootPath, "scripts", "probe.mjs");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(path.join(rootPath, "SKILL.md"), "# Standalone skill\n", "utf8");
    await fs.writeFile(
      filePath,
      "import assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\nconst text = readFileSync(process.cwd(), 'utf8');\nassert.equal(typeof text, 'string');\nconst uncheckedValue = 1;\nuncheckedValue.toUpperCase();\n",
      "utf8"
    );

    const manager = new LspManager(rootPath);
    try {
      const report = await manager.forFile(filePath).diagnostics(filePathToUri(filePath));
      expect(report.status).toBe("ok");
      expect(report.timedOut).toBe(false);
      expect(report.stale).toBe(false);
      expect(report.sourceRevision).toBe(1);
      expect(report.items.some((item) => item.code === 2591 || item.code === 2307)).toBe(false);
      expect(report.items.some((item) => item.code === 2339)).toBe(true);
    } finally {
      await manager.dispose();
      await fs.rm(rootPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 20000);

  it.skipIf(!hasBundledNodeTypeRoot)("preserves explicit checkJs diagnostics for a configured jsconfig project", async () => {
    await expectConfiguredJavaScriptProjectDiagnostics("jsconfig.json");
  }, 20000);

  it.skipIf(!hasBundledNodeTypeRoot)("preserves explicit checkJs diagnostics for a configured tsconfig project", async () => {
    await expectConfiguredJavaScriptProjectDiagnostics("tsconfig.json");
  }, 20000);

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
      diagnosticsTimeoutMs: 10000,
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
      await fs.rm(rootPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 20000);

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
      diagnosticsTimeoutMs: 10000,
      clientFactory: (server) => new JsonRpcLspClient(server)
    });

    try {
      await expect(provider.diagnostics(filePathToUri(filePath))).resolves.toMatchObject({
        status: "ok",
        items: [expect.objectContaining({ severity: "error" })]
      });
    } finally {
      await provider.dispose();
      await fs.rm(rootPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 20000);
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
      await fs.rm(rootPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 20000);
});

async function expectConfiguredJavaScriptProjectDiagnostics(configName: "jsconfig.json" | "tsconfig.json"): Promise<void> {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-configured-js-fixture-"));
  const filePath = path.join(rootPath, "scripts", "probe.mjs");
  const typeRoot = resolveNodeTypeRoots(rootPath, process.execPath)[0];
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(path.join(rootPath, "SKILL.md"), "# Standalone skill\n", "utf8");
  await fs.writeFile(
    path.join(rootPath, configName),
    JSON.stringify({
      compilerOptions: {
        allowJs: true,
        checkJs: true,
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        types: ["node"],
        typeRoots: [typeRoot]
      },
      include: ["scripts/**/*.mjs"]
    }),
    "utf8"
  );
  await fs.writeFile(
    filePath,
    "import assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\nassert.equal(typeof readFileSync, 'function');\nconst value = 1;\nvalue.toUpperCase();\n",
    "utf8"
  );

  const manager = new LspManager(rootPath);
  try {
    const report = await manager.forFile(filePath).diagnostics(filePathToUri(filePath));
    expect(report.status).toBe("ok");
    expect(report.timedOut).toBe(false);
    expect(report.stale).toBe(false);
    expect(report.items.some((item) => item.code === 2591)).toBe(false);
    expect(report.items.some((item) => item.code === 2339)).toBe(true);
  } finally {
    await manager.dispose();
    await fs.rm(rootPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

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
