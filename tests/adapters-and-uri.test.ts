import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createLanguageServerConfig,
  detectLanguageFromFile,
  listLanguageServerConfigs,
  resolveServerCommand,
  supportedLanguages
} from "../src/adapters/language-config.js";
import { canonicalizeFileUri, filePathToUri, uriToFilePath } from "../src/utils/uri.js";

describe("language config", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-adapters-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("creates immutable language server command configs", () => {
    const config = createLanguageServerConfig("typescript", ".");

    expect(config).toMatchObject({
      language: "typescript",
      languageId: "typescript",
      installHint: "npm install -g typescript-language-server typescript",
      supportLevel: "primary",
      workspaceSeedFiles: expect.arrayContaining(["src/proxy.ts"]),
      server: { command: expect.stringContaining("typescript-language-server"), args: ["--stdio"] }
    });
    expect(path.isAbsolute(config.server.cwd)).toBe(true);
  });

  it("detects supported languages from file extensions", () => {
    expect(detectLanguageFromFile("src/app.tsx")).toBe("typescript");
    expect(detectLanguageFromFile("src/main.rs")).toBe("rust");
    expect(detectLanguageFromFile("src/main.py")).toBe("python");
    expect(detectLanguageFromFile("cmd/server/main.go")).toBe("go");
    expect(() => detectLanguageFromFile("README.md")).toThrow("Unsupported file extension");
  });

  it("lists language configs from the canonical registry", () => {
    expect(supportedLanguages()).toEqual(["typescript", "rust", "python", "go"]);
    expect(listLanguageServerConfigs(".")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          language: "go",
          languageId: "go",
          installHint: "go install golang.org/x/tools/gopls@latest",
          supportLevel: "experimental",
          server: expect.objectContaining({ command: "gopls" })
        })
      ])
    );
  });

  it("resolves local Windows npm shims before falling back to a bare command", async () => {
    const binDirectory = path.join(tempRoot, "node_modules", ".bin");
    const extensionlessShim = path.join(binDirectory, "typescript-language-server");
    const shim = path.join(binDirectory, "typescript-language-server.cmd");
    await fs.mkdir(binDirectory, { recursive: true });
    await fs.writeFile(extensionlessShim, "#!/bin/sh\n", "utf8");
    await fs.writeFile(shim, "@echo off\r\n", "utf8");

    expect(resolveServerCommand(tempRoot, "typescript-language-server", { platform: "win32" })).toBe(shim);
  });

  it("resolves Windows PATH commands using PATHEXT", async () => {
    const binDirectory = path.join(tempRoot, "bin");
    const shim = path.join(binDirectory, "pyright-langserver.cmd");
    await fs.mkdir(binDirectory, { recursive: true });
    await fs.writeFile(shim, "@echo off\r\n", "utf8");

    expect(
      resolveServerCommand(tempRoot, "pyright-langserver", {
        platform: "win32",
        env: { PATH: binDirectory, PATHEXT: ".EXE;.CMD" }
      })
    ).toBe(shim);
  });
});

describe("file URI helpers", () => {
  it("round-trips file paths through file URIs", () => {
    const filePath = path.resolve("src/index.ts");

    expect(uriToFilePath(filePathToUri(filePath))).toBe(filePath);
    expect(() => uriToFilePath("https://example.com/file.ts")).toThrow("Only file:// URIs are supported");
  });

  it("canonicalizes Windows drive-letter file URIs", () => {
    expect(canonicalizeFileUri("file:///c%3A/Users/Jack/project/src/a.ts")).toBe("file:///C:/Users/Jack/project/src/a.ts");
    expect(canonicalizeFileUri("file:///c:/Users/Jack/project/src/a.ts")).toBe("file:///C:/Users/Jack/project/src/a.ts");
    expect(canonicalizeFileUri("file:///C:/Users/Jack/project/src/a.ts")).toBe("file:///C:/Users/Jack/project/src/a.ts");
  });
});
