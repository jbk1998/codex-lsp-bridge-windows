import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, LspClientConfigError, mcpIdleTimeoutPolicy, resolveMcpConnectionIdleTimeout } from "../src/core/config.js";

describe("config", () => {
  let rootPath = "";
  let additionalRootPath = "";
  let homePath = "";
  const originalCodexHome = process.env.CODEX_HOME;

  afterEach(async () => {
    if (rootPath) await fs.rm(rootPath, { recursive: true, force: true });
    if (additionalRootPath) await fs.rm(additionalRootPath, { recursive: true, force: true });
    if (homePath) await fs.rm(homePath, { recursive: true, force: true });
    additionalRootPath = "";
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
      JSON.stringify({ diagnosticsTimeoutMs: 3000, mcpIdleTimeoutMs: 1800000, hook: { maxFiles: 9 }, defaultLanguage: "python" })
    );
    await fs.writeFile(
      path.join(rootPath, ".codex", "lsp-client.json"),
      JSON.stringify({ hook: { verbosePending: true }, defaultLanguage: "typescript" })
    );

    expect(loadConfig(rootPath)).toMatchObject({
      defaultLanguage: "typescript",
      diagnosticsTimeoutMs: 3000,
      mcpIdleTimeoutMs: 1800000,
      hook: { maxFiles: 9, verbosePending: true }
    });
  });

  it("uses a diagnostics timeout suitable for cold language-server analysis by default", async () => {
    rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-config-root-"));
    homePath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-config-home-"));
    process.env.CODEX_HOME = path.join(homePath, ".codex");

    expect(loadConfig(rootPath)).toMatchObject({
      diagnosticsTimeoutMs: 15000
    });
  });

  it("accepts zero to disable the MCP idle timeout and rejects invalid values", async () => {
    rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-config-root-"));
    homePath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-config-home-"));
    process.env.CODEX_HOME = path.join(homePath, ".codex");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });
    await fs.writeFile(path.join(process.env.CODEX_HOME, "lsp-client.json"), JSON.stringify({ mcpIdleTimeoutMs: 0 }));

    expect(loadConfig(rootPath).mcpIdleTimeoutMs).toBe(0);

    await fs.writeFile(path.join(process.env.CODEX_HOME, "lsp-client.json"), JSON.stringify({ mcpIdleTimeoutMs: 1.5 }));
    expect(() => loadConfig(rootPath)).toThrow("mcpIdleTimeoutMs must be a non-negative safe integer");
  });

  it("uses the startup root idle policy for a multi-root MCP connection", async () => {
    rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-config-root-"));
    additionalRootPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-config-second-root-"));
    homePath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-config-home-"));
    process.env.CODEX_HOME = path.join(homePath, ".codex");
    await fs.mkdir(path.join(rootPath, ".codex"), { recursive: true });
    await fs.mkdir(path.join(additionalRootPath, ".codex"), { recursive: true });
    await fs.writeFile(path.join(rootPath, ".codex", "lsp-client.json"), JSON.stringify({ mcpIdleTimeoutMs: 1000 }));
    await fs.writeFile(path.join(additionalRootPath, ".codex", "lsp-client.json"), JSON.stringify({ mcpIdleTimeoutMs: 2000 }));

    expect(mcpIdleTimeoutPolicy).toBe("connection-startup");
    const startupIdleTimeoutMs = resolveMcpConnectionIdleTimeout(loadConfig(rootPath));
    expect(startupIdleTimeoutMs).toBe(1000);
    expect(resolveMcpConnectionIdleTimeout(loadConfig(additionalRootPath))).toBe(2000);
    // Selecting the second root supplies its manager/config, but cannot mutate
    // the timer captured when the MCP connection started at rootPath.
    expect(startupIdleTimeoutMs).toBe(1000);
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

  it("accepts Rust as the default language", async () => {
    rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-config-root-"));
    await fs.mkdir(path.join(rootPath, ".codex"), { recursive: true });
    await fs.writeFile(path.join(rootPath, ".codex", "lsp-client.json"), JSON.stringify({ defaultLanguage: "rust" }));

    expect(loadConfig(rootPath)).toMatchObject({
      defaultLanguage: "rust"
    });
  });

  it("accepts executable overrides only from trusted global config", async () => {
    rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-config-root-"));
    homePath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-config-home-"));
    process.env.CODEX_HOME = path.join(homePath, ".codex");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });
    await fs.mkdir(path.join(rootPath, ".codex"), { recursive: true });
    await fs.writeFile(
      path.join(process.env.CODEX_HOME, "lsp-client.json"),
      JSON.stringify({ languageServers: { typescript: { command: "trusted-ts-ls", args: ["--stdio"] } } })
    );
    await fs.writeFile(
      path.join(rootPath, ".codex", "lsp-client.json"),
      JSON.stringify({
        defaultLanguage: "python",
        languageServers: {
          typescript: { command: "untrusted-command", args: ["--run-project-code"] },
          python: { command: "untrusted-python", args: [] }
        }
      })
    );

    expect(loadConfig(rootPath)).toMatchObject({
      defaultLanguage: "python",
      languageServers: {
        typescript: { command: "trusted-ts-ls", args: ["--stdio"] }
      }
    });
    expect(loadConfig(rootPath).languageServers.python).toBeUndefined();
  });

  it("reports malformed global JSON with its path and an actionable fix", async () => {
    rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-config-root-"));
    homePath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-config-home-"));
    process.env.CODEX_HOME = path.join(homePath, ".codex");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });
    const configPath = path.join(process.env.CODEX_HOME, "lsp-client.json");
    await fs.writeFile(configPath, '{\n  "defaultLanguage": "typescript"\n');

    expect(() => loadConfig(rootPath)).toThrow(LspClientConfigError);
    expect(() => loadConfig(rootPath)).toThrow(configPath);
    expect(() => loadConfig(rootPath)).toThrow("invalid JSON");
    expect(() => loadConfig(rootPath)).toThrow("fix the JSON syntax or remove the file");
  });

  it("blocks a workspace when its config is not a JSON object", async () => {
    rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-config-root-"));
    homePath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-config-home-"));
    process.env.CODEX_HOME = path.join(homePath, ".codex");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });
    await fs.mkdir(path.join(rootPath, ".codex"), { recursive: true });
    const configPath = path.join(rootPath, ".codex", "lsp-client.json");
    await fs.writeFile(configPath, "[]");

    expect(() => loadConfig(rootPath)).toThrow(LspClientConfigError);
    expect(() => loadConfig(rootPath)).toThrow(`Invalid LSP client config at ${configPath}`);
    expect(() => loadConfig(rootPath)).toThrow("top-level value must be a JSON object");
  });
});
