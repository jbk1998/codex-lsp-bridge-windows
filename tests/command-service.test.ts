import { describe, expect, it } from "vitest";
import { CommandService } from "../src/core/command-service.js";
import type { Diagnostic, HoverInfo, Location, SemanticProvider, SymbolMatch } from "../src/core/types.js";

class FakeProvider implements SemanticProvider {
  diagnostics(): Promise<Diagnostic[]> {
    return Promise.resolve([
      {
        file: "src/editor/store.ts",
        line: 182,
        character: 7,
        severity: "error",
        message: "Property 'id' does not exist on type"
      }
    ]);
  }

  definition(symbol: string): Promise<Location> {
    return Promise.resolve({ file: `src/${symbol}.ts`, line: 24, character: 1 });
  }

  definitionAt(): Promise<Location> {
    return Promise.resolve({ file: "src/position.ts", line: 2, character: 3 });
  }

  references(): Promise<Location[]> {
    return Promise.resolve([{ file: "src/pages/home.tsx", line: 44, character: 9 }]);
  }

  referencesAt(): Promise<Location[]> {
    return Promise.resolve([{ file: "src/position.ts", line: 2, character: 3 }]);
  }

  symbols(query: string): Promise<SymbolMatch[]> {
    return Promise.resolve([{ name: query, file: "src/editor.ts", line: 1, character: 1 }]);
  }

  hover(symbol: string): Promise<HoverInfo> {
    return Promise.resolve({ file: "src/editor.ts", line: 1, character: 1, contents: `type ${symbol} = string` });
  }

  hoverAt(): Promise<HoverInfo> {
    return Promise.resolve({ file: "src/position.ts", line: 2, character: 3, contents: "position hover" });
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

describe("CommandService", () => {
  it("returns compressed diagnostic summaries", async () => {
    const service = new CommandService(new FakeProvider());

    await expect(service.diagnostics()).resolves.toMatchObject({
      total: 1,
      summary: ["1. ERROR src/editor/store.ts:182:7 Property 'id' does not exist on type"]
    });
  });

  it("rejects empty symbol commands at the command boundary", async () => {
    const service = new CommandService(new FakeProvider());

    await expect(service.definition(" ")).rejects.toThrow("symbol is required");
    await expect(service.symbols("")).rejects.toThrow("query is required");
    await expect(service.definitionAt({ file: "", line: 1, character: 1 })).rejects.toThrow("file is required");
    await expect(service.definitionAt({ file: "src/a.ts", line: 0, character: 1 })).rejects.toThrow(
      "line must be a positive integer"
    );
  });

  it("delegates read-only semantic commands to the provider", async () => {
    const service = new CommandService(new FakeProvider());

    await expect(service.definition("useEditorStore")).resolves.toMatchObject({
      file: "src/useEditorStore.ts",
      line: 24
    });
    await expect(service.references("ProductCard")).resolves.toHaveLength(1);
    await expect(service.definitionAt({ file: "src/index.ts", line: 2, character: 10 })).resolves.toMatchObject({
      file: "src/position.ts"
    });
    await expect(service.referencesAt({ file: "src/index.ts", line: 2, character: 10 })).resolves.toHaveLength(1);
    await expect(service.symbols("Editor")).resolves.toMatchObject([{ name: "Editor" }]);
    await expect(service.hover("EditorState")).resolves.toMatchObject({ contents: "type EditorState = string" });
    await expect(service.hoverAt({ file: "src/index.ts", line: 2, character: 10 })).resolves.toMatchObject({
      contents: "position hover"
    });
  });
});
