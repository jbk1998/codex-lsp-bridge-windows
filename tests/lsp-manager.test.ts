import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LspManager } from "../src/core/lsp-manager.js";

describe("LspManager", () => {
  it("lazily creates one provider per language", () => {
    const manager = new LspManager(process.cwd());

    expect(manager.forLanguage("typescript")).toBe(manager.forLanguage("typescript"));
    expect(manager.forFile("src/app.ts")).toBe(manager.forLanguage("typescript"));
    expect(manager.forFile("src/main.rs")).toBe(manager.forLanguage("rust"));
    expect(manager.forFile("cmd/server/main.go")).toBe(manager.forLanguage("go"));
  });

  it("rejects unsupported file extensions at the manager boundary", () => {
    const manager = new LspManager(process.cwd());

    expect(() => manager.forFile("README.md")).toThrow("Unsupported file extension");
  });

  it("disposes created providers", async () => {
    const manager = new LspManager(process.cwd());
    manager.forLanguage("typescript");

    await expect(manager.dispose()).resolves.toBeUndefined();
  });

  it("keeps managers and providers isolated by workspace root", async () => {
    const firstRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-manager-first-"));
    const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-manager-second-"));
    const first = new LspManager(firstRoot);
    const second = new LspManager(secondRoot);
    try {
      expect(first.forLanguage("typescript")).not.toBe(second.forLanguage("typescript"));
    } finally {
      await Promise.all([first.dispose(), second.dispose()]);
      await Promise.all([
        fs.rm(firstRoot, { recursive: true, force: true }),
        fs.rm(secondRoot, { recursive: true, force: true })
      ]);
    }
  });

  it("does not reuse a manager after its root directory is replaced", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-manager-replaced-"));
    const manager = new LspManager(root);
    manager.forLanguage("typescript");
    try {
      await fs.rm(root, { recursive: true, force: true });
      await fs.mkdir(root, { recursive: true });
      expect(() => manager.forLanguage("typescript")).toThrow("root_replaced");
    } finally {
      await manager.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
