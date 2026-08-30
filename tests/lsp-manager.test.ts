import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LspManager } from "../src/core/lsp-manager.js";
import type { DiagnosticReport, HoverInfo, Location, SemanticProvider, SymbolMatch } from "../src/core/types.js";
import type { DisposalDeadline, ProcessTerminationResult } from "../src/core/process-ownership.js";

class DisposalSequenceProvider implements SemanticProvider {
  disposeCalls = 0;

  constructor(private readonly results: Array<ProcessTerminationResult | void>) {}

  diagnostics(): Promise<DiagnosticReport> {
    return Promise.resolve({ status: "ok", timedOut: false, stale: false, items: [] });
  }
  definition(): Promise<Location> {
    return Promise.reject(new Error("unused"));
  }
  definitionAt(): Promise<Location> {
    return Promise.reject(new Error("unused"));
  }
  references(): Promise<Location[]> {
    return Promise.resolve([]);
  }
  referencesAt(): Promise<Location[]> {
    return Promise.resolve([]);
  }
  symbols(): Promise<SymbolMatch[]> {
    return Promise.resolve([]);
  }
  hover(): Promise<HoverInfo> {
    return Promise.reject(new Error("unused"));
  }
  hoverAt(): Promise<HoverInfo> {
    return Promise.reject(new Error("unused"));
  }
  dispose(_deadline?: DisposalDeadline): Promise<ProcessTerminationResult | void> {
    const result = this.results[Math.min(this.disposeCalls, this.results.length - 1)];
    this.disposeCalls += 1;
    return Promise.resolve(result);
  }
}

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

  it("suspends providers while keeping the manager reusable", async () => {
    const manager = new LspManager(process.cwd());
    const firstProvider = manager.forLanguage("typescript");

    await expect(manager.suspend()).resolves.toBeUndefined();
    expect(manager.forLanguage("typescript")).not.toBe(firstProvider);

    await manager.dispose();
  });

  it("retains non-cleanly suspended providers for final cleanup", async () => {
    const first = new DisposalSequenceProvider([
      { clean: false, reasonCode: "exit_unconfirmed" },
      { clean: true, reasonCode: "owned_child_exit" }
    ]);
    const second = new DisposalSequenceProvider([undefined]);
    const providers = [first, second];
    const manager = new LspManager(process.cwd(), {
      providerFactory: () => providers.shift() ?? second
    });

    manager.forLanguage("typescript");
    await expect(manager.suspend()).resolves.toMatchObject({ clean: false, reasonCode: "exit_unconfirmed" });
    manager.forLanguage("typescript");
    await expect(manager.dispose()).resolves.toMatchObject({ clean: true });

    expect(first.disposeCalls).toBe(2);
    expect(second.disposeCalls).toBe(1);
  });

  it("retries a non-clean final disposal instead of caching it forever", async () => {
    const provider = new DisposalSequenceProvider([
      { clean: false, reasonCode: "exit_unconfirmed" },
      { clean: true, reasonCode: "owned_child_exit" }
    ]);
    const manager = new LspManager(process.cwd(), { providerFactory: () => provider });
    manager.forLanguage("typescript");

    await expect(manager.dispose()).resolves.toMatchObject({ clean: false, reasonCode: "exit_unconfirmed" });
    await expect(manager.dispose()).resolves.toMatchObject({ clean: true, reasonCode: "owned_child_exit" });
    expect(provider.disposeCalls).toBe(2);
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
      await Promise.all([fs.rm(firstRoot, { recursive: true, force: true }), fs.rm(secondRoot, { recursive: true, force: true })]);
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
