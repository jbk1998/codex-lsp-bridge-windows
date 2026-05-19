import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.js";

describe("config", () => {
  let rootPath = "";
  let homePath = "";
  const originalCodexHome = process.env.CODEX_HOME;

  afterEach(async () => {
    if (rootPath) await fs.rm(rootPath, { recursive: true, force: true });
    if (homePath) await fs.rm(homePath, { recursive: true, force: true });
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
  });

  it("merges global and project lsp-client config", async () => {
    rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-config-root-"));
    homePath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-config-home-"));
    process.env.CODEX_HOME = path.join(homePath, ".codex");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });
    await fs.mkdir(path.join(rootPath, ".codex"), { recursive: true });
    await fs.writeFile(
      path.join(process.env.CODEX_HOME, "lsp-client.json"),
      JSON.stringify({ diagnosticsTimeoutMs: 3000, hook: { maxFiles: 9 }, defaultLanguage: "python" })
    );
    await fs.writeFile(
      path.join(rootPath, ".codex", "lsp-client.json"),
      JSON.stringify({ hook: { verbosePending: true }, defaultLanguage: "typescript" })
    );

    expect(loadConfig(rootPath)).toMatchObject({
      defaultLanguage: "typescript",
      diagnosticsTimeoutMs: 3000,
      hook: { maxFiles: 9, verbosePending: true }
    });
  });

  it("uses a diagnostics timeout suitable for cold language-server analysis by default", async () => {
    rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-config-root-"));

    expect(loadConfig(rootPath)).toMatchObject({
      diagnosticsTimeoutMs: 15000
    });
  });

  it("accepts auto diagnostics timeout policy", async () => {
    rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-config-root-"));
    homePath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-config-home-"));
    process.env.CODEX_HOME = path.join(homePath, ".codex");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });
    await fs.writeFile(path.join(process.env.CODEX_HOME, "lsp-client.json"), JSON.stringify({ diagnosticsTimeoutMs: "auto" }));

    expect(loadConfig(rootPath)).toMatchObject({
      diagnosticsTimeoutMs: "auto"
    });
  });
});
