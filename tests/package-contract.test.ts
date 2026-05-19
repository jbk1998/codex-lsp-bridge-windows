import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = process.cwd();

function readJson<T>(relativePath: string): T {
  return JSON.parse(fs.readFileSync(path.join(packageRoot, relativePath), "utf8")) as T;
}

describe("package contract", () => {
  it("publishes every Codex plugin surface needed for one-command use", () => {
    const pkg = readJson<{
      bin: Record<string, string>;
      files: string[];
      scripts: Record<string, string>;
    }>("package.json");

    expect(pkg.bin).toMatchObject({
      "codex-lsp-bridge": "dist/index.js",
      "codex-lsp-bridge-install": "scripts/install-codex.mjs",
      "codex-lsp-bridge-uninstall": "scripts/uninstall-codex.mjs"
    });
    expect(pkg.files).toEqual(
      expect.arrayContaining([
        "dist/index.js",
        "dist/adapters",
        "dist/core",
        "dist/transport",
        "dist/utils",
        "scripts/codex-lsp-post-tool-use.mjs",
        "scripts/install-codex.mjs",
        "scripts/uninstall-codex.mjs",
        ".codex-plugin/plugin.json",
        ".mcp.json",
        "hooks/hooks.json",
        "skills/lsp/SKILL.md",
        "docs/RELEASE.md",
        "docs/MARKETPLACE.md",
        "README.md",
        "CHANGELOG.md",
        "LICENSE",
        "SECURITY.md"
      ])
    );
    expect(pkg.scripts).toMatchObject({
      "verify:package": "node scripts/verify-package.mjs",
      "smoke:install": "node scripts/smoke-install.mjs",
      "smoke:package": "node scripts/smoke-package.mjs",
      "ci:verify": "npm run type-check && npm test && npm run build && npm run verify:package && npm run smoke:install && npm run smoke:package"
    });
  });

  it("keeps plugin metadata aligned with included files", () => {
    const plugin = readJson<{
      mcpServers: Record<string, { command: string; args: string[] }>;
      skills: string[];
      hooks: string;
    }>(".codex-plugin/plugin.json");
    const mcp = readJson<{ mcpServers: Record<string, { command: string; args: string[] }> }>(".mcp.json");

    expect(plugin.mcpServers["codex-lsp-bridge"]).toEqual({
      command: "codex-lsp-bridge",
      args: ["mcp"]
    });
    expect(mcp.mcpServers["codex-lsp-bridge"]).toEqual(plugin.mcpServers["codex-lsp-bridge"]);
    expect(plugin.skills).toEqual(["skills/lsp/SKILL.md"]);
    expect(plugin.hooks).toBe("hooks/hooks.json");
    expect(fs.existsSync(path.join(packageRoot, plugin.skills[0]))).toBe(true);
    expect(fs.existsSync(path.join(packageRoot, plugin.hooks))).toBe(true);
  });
});
