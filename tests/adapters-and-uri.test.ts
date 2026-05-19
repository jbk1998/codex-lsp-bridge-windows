import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLanguageServerConfig, detectLanguageFromFile } from "../src/adapters/language-config.js";
import { filePathToUri, uriToFilePath } from "../src/utils/uri.js";

describe("language config", () => {
  it("creates immutable language server command configs", () => {
    const config = createLanguageServerConfig("typescript", ".");

    expect(config).toMatchObject({
      language: "typescript",
      languageId: "typescript",
      workspaceSeedFiles: expect.arrayContaining(["src/proxy.ts"]),
      server: { command: "typescript-language-server", args: ["--stdio"] }
    });
    expect(path.isAbsolute(config.server.cwd)).toBe(true);
  });

  it("detects supported languages from file extensions", () => {
    expect(detectLanguageFromFile("src/app.tsx")).toBe("typescript");
    expect(detectLanguageFromFile("src/main.rs")).toBe("rust");
    expect(detectLanguageFromFile("src/main.py")).toBe("python");
    expect(() => detectLanguageFromFile("README.md")).toThrow("Unsupported file extension");
  });
});

describe("file URI helpers", () => {
  it("round-trips file paths through file URIs", () => {
    const filePath = path.resolve("src/index.ts");

    expect(uriToFilePath(filePathToUri(filePath))).toBe(filePath);
    expect(() => uriToFilePath("https://example.com/file.ts")).toThrow("Only file:// URIs are supported");
  });
});
