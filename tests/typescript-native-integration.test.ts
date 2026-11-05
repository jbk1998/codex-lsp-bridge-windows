import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LspManager } from "../src/core/lsp-manager.js";
import { filePathToUri } from "../src/utils/uri.js";

const nativeExecutablePath = process.env.CODEX_LSP_TYPESCRIPT_NATIVE_EXECUTABLE;
if (process.env.CODEX_LSP_REQUIRE_TYPESCRIPT_NATIVE_INTEGRATION === "1") {
  if (!nativeExecutablePath || !path.isAbsolute(nativeExecutablePath) || !fsSync.existsSync(nativeExecutablePath)) {
    throw new Error(
      "Required TypeScript 7 native integration needs CODEX_LSP_TYPESCRIPT_NATIVE_EXECUTABLE to be an existing absolute path"
    );
  }
}

describe.skipIf(!nativeExecutablePath)("native TypeScript 7 LSP integration", () => {
  it("round-trips diagnostics and exercises semantic requests through LspManager", async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-ts7-native-fixture-"));
    const sourcePath = path.join(rootPath, "src", "util.ts");
    const filePath = path.join(rootPath, "src", "index.ts");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(path.join(rootPath, "package.json"), JSON.stringify({ type: "module" }), "utf8");
    await fs.writeFile(
      path.join(rootPath, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" },
        include: ["src"]
      }),
      "utf8"
    );
    await fs.writeFile(sourcePath, "export function add(left: number, right: number): number { return left + right; }\n", "utf8");
    const invalidSource = 'import { add } from "./util.js";\nconst value: string = add(2, 3);\nconsole.log(value);\n';
    const validSource = 'import { add } from "./util.js";\nconst value: number = add(2, 3);\nconsole.log(value);\n';
    await fs.writeFile(filePath, invalidSource, "utf8");

    const manager = new LspManager(rootPath, {
      languageServers: { typescript: { backend: "native", executablePath: nativeExecutablePath } }
    });

    try {
      const provider = manager.forFile(filePath);
      const uri = filePathToUri(filePath);
      const initial = await provider.diagnostics(uri, { timeoutMs: 30000 });
      expect(initial).toMatchObject({ status: "ok", timedOut: false, stale: false, sourceRevision: 1, configurationIssues: [] });
      expect(initial.items.map(({ code }) => code)).toContain(2322);

      await fs.writeFile(filePath, validSource, "utf8");
      const clean = await provider.diagnostics(uri, { timeoutMs: 30000 });
      expect(clean).toMatchObject({ status: "ok", timedOut: false, stale: false, sourceRevision: 2, items: [] });

      await fs.writeFile(filePath, invalidSource, "utf8");
      const restored = await provider.diagnostics(uri, { timeoutMs: 30000 });
      expect(restored).toMatchObject({ status: "ok", timedOut: false, stale: false, sourceRevision: 3 });
      expect(restored.items.map(({ code }) => code)).toContain(2322);

      const addCharacter = invalidSource.indexOf("add") + 1;
      const sourceRealPath = await fs.realpath(sourcePath);
      const definition = await provider.definitionAt({ file: filePath, line: 1, character: addCharacter });
      expect(await fs.realpath(definition.file)).toBe(sourceRealPath);
      const references = await provider.referencesAt({ file: filePath, line: 1, character: addCharacter });
      const referencePaths = await Promise.all(references.map((location) => fs.realpath(location.file)));
      expect(referencePaths).toContain(sourceRealPath);
      const symbols = await provider.symbols("add");
      const symbolPaths = await Promise.all(symbols.map((symbol) => fs.realpath(symbol.file)));
      expect(symbols.some((symbol, index) => symbol.name === "add" && symbolPaths[index] === sourceRealPath)).toBe(true);
      const hover = await provider.hoverAt({ file: filePath, line: 1, character: addCharacter });
      expect(hover.contents).toContain("number");
    } finally {
      try {
        const disposal = await manager.dispose();
        expect(disposal).toMatchObject({ clean: true });
      } finally {
        await fs.rm(rootPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }
  }, 120000);
});
