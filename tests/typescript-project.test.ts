import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveInferredTypeScriptProjectOptions, resolveNodeTypeRoots } from "../src/core/typescript-project.js";

const temporaryRoots: string[] = [];
const testRequire = createRequire(import.meta.url);

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

  it("walks runtime ancestors when the executable is nested below its bundled types", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-skill-root-"));
    const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-runtime-"));
    temporaryRoots.push(root, runtimeRoot);
    const typeRoot = path.join(runtimeRoot, "node_modules", "@types");
    await fs.mkdir(path.join(typeRoot, "node"), { recursive: true });
    await fs.writeFile(path.join(typeRoot, "node", "index.d.ts"), "", "utf8");

    const runtimePath = path.join(runtimeRoot, "layers", "one", "two", "bin", "node.exe");
    expect(resolveNodeTypeRoots(root, runtimePath)).toEqual([typeRoot]);
  });

  it("uses the bridge package's Node types when the active runtime has no type root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-skill-root-"));
    temporaryRoots.push(root);
    const packageTypeRoot = path.dirname(path.dirname(testRequire.resolve("@types/node/package.json")));

    expect(resolveNodeTypeRoots(root, path.join(root, "runtime", "node.exe"))).toContain(packageTypeRoot);
    expect(resolveInferredTypeScriptProjectOptions(root, path.join(root, "runtime", "node.exe"))).toMatchObject({
      types: ["node"],
      compilerOptions: { types: ["node"] }
    });
  });

  it("does not climb past an unrelated runtime package boundary", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-skill-root-"));
    const runtimeContainer = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-runtime-container-"));
    temporaryRoots.push(root, runtimeContainer);
    const ambientTypeRoot = path.join(runtimeContainer, "node_modules", "@types");
    await fs.mkdir(path.join(ambientTypeRoot, "node"), { recursive: true });
    await fs.writeFile(path.join(ambientTypeRoot, "node", "index.d.ts"), "", "utf8");

    const runtimeRoot = path.join(runtimeContainer, "runtime");
    await fs.mkdir(path.join(runtimeRoot, "node_modules"), { recursive: true });
    const resolved = resolveNodeTypeRoots(root, path.join(runtimeRoot, "layers", "bin", "node.exe"));

    expect(resolved).not.toContain(ambientTypeRoot);
  });

  it("preserves visible runtime declarations while keeping Node in scope", async () => {
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

  it("keeps a custom-only runtime type root when Node comes from the bridge", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-skill-root-"));
    const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-runtime-"));
    temporaryRoots.push(root, runtimeRoot);
    const typeRoot = path.join(runtimeRoot, "node_modules", "@types");
    await fs.mkdir(path.join(typeRoot, "custom"), { recursive: true });
    await fs.writeFile(path.join(typeRoot, "custom", "index.d.ts"), "", "utf8");

    const resolved = resolveInferredTypeScriptProjectOptions(root, path.join(runtimeRoot, "bin", "node.exe"));
    expect(resolved).toMatchObject({
      typeRoots: expect.arrayContaining([typeRoot]),
      types: ["custom", "node"],
      compilerOptions: expect.objectContaining({
        types: ["custom", "node"],
        typeRoots: expect.arrayContaining([typeRoot])
      })
    });
  });
});
