import { describe, expect, it } from "vitest";
import { LspManager } from "../src/core/lsp-manager.js";

describe("LspManager", () => {
  it("lazily creates one provider per language", () => {
    const manager = new LspManager(process.cwd());

    expect(manager.forLanguage("typescript")).toBe(manager.forLanguage("typescript"));
    expect(manager.forFile("src/app.ts")).toBe(manager.forLanguage("typescript"));
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
});
