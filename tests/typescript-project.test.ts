import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveInferredTypeScriptProjectOptions, resolveNodeTypeRoots } from "../src/core/typescript-project.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("standalone TypeScript project discovery", () => {
  it("finds bundled-style @types/node beside the configured Node runtime", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-skill-root-"));
    const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-runtime-"));
    temporaryRoots.push(root, runtimeRoot);
    await fs.writeFile(path.join(root, "SKILL.md"), "# Skill\n", "utf8");
    await fs.mkdir(path.join(runtimeRoot, "node_modules", "@types", "node"), { recursive: true });
    await fs.writeFile(path.join(runtimeRoot, "node_modules", "@types", "node", "index.d.ts"), "declare module 'node:fs';\n", "utf8");

    const runtimePath = path.join(runtimeRoot, "node.exe");
    expect(resolveNodeTypeRoots(root, runtimePath)).toEqual([
      path.join(runtimeRoot, "node_modules", "@types")
    ]);
  });

  it("builds inferred-project options that keep Node and other visible type packages in scope", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-skill-root-"));
    const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-runtime-"));
    temporaryRoots.push(root, runtimeRoot);
    const typeRoot = path.join(runtimeRoot, "node_modules", "@types");
    await fs.mkdir(path.join(typeRoot, "node"), { recursive: true });
    await fs.mkdir(path.join(typeRoot, "custom"), { recursive: true });
    await fs.writeFile(path.join(typeRoot, "node", "index.d.ts"), "", "utf8");
    await fs.writeFile(path.join(typeRoot, "custom", "index.d.ts"), "", "utf8");

    const resolved = resolveInferredTypeScriptProjectOptions(root, path.join(runtimeRoot, "bin", "node.exe"));
    expect(resolved).toMatchObject({
      typeRoots: [typeRoot],
      types: ["custom", "node"],
      compilerOptions: expect.objectContaining({
        allowJs: true,
        allowNonTsExtensions: true,
        checkJs: false,
        noImplicitAny: false,
        strict: false,
        types: ["custom", "node"],
        typeRoots: [typeRoot]
      })
    });
  });
});
