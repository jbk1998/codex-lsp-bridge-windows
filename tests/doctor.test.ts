import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectBuildFreshness, runDoctor } from "../src/core/doctor.js";

describe("doctor", () => {
  it("reports every registered language server command", () => {
    const result = runDoctor(process.cwd());

    expect(result.languages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          language: "typescript",
          command: expect.stringContaining("typescript-language-server"),
          supportLevel: "primary",
          installHint: "npm install -g typescript-language-server typescript"
        }),
        expect.objectContaining({ language: "rust", command: "rust-analyzer", supportLevel: "experimental" }),
        expect.objectContaining({ language: "python", command: "pyright-langserver", supportLevel: "experimental" }),
        expect.objectContaining({ language: "go", command: "gopls", supportLevel: "experimental" })
      ])
    );
    expect(result.languages.every((entry) => entry.status === "ok" || entry.status === "missing")).toBe(true);
    expect(result.codex).toEqual(
      expect.objectContaining({
        mcpConfigured: expect.any(Boolean),
        hookConfigured: expect.any(Boolean),
        instructionsConfigured: expect.any(Boolean)
      })
    );
    expect(result.build).toEqual(expect.objectContaining({ distExists: expect.any(Boolean), stale: expect.any(Boolean) }));
    expect(result.recommendations).toEqual(expect.any(Array));
  });

  it("does not treat package installs without src as stale", () => {
    const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-lsp-package-root-"));
    fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "dist", "index.js"), "");

    expect(inspectBuildFreshness(packageRoot)).toEqual({ distExists: true, stale: false });

    fs.rmSync(packageRoot, { recursive: true, force: true });
  });
});
