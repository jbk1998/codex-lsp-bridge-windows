#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-lsp-install-"));
const env = { ...process.env, CODEX_HOME: codexHome };

run(["scripts/install-codex.mjs"]);

const config = read("config.toml");
const hooks = read("hooks.json");
const agents = read("AGENTS.md");

assert(config.includes("[mcp_servers.codex-lsp-bridge]"), "install did not write MCP config");
assert(config.replaceAll("\\", "/").replace(/\/+/g, "/").includes("dist/index.js"), "install did not point MCP config at local dist");
assert(hooks.includes("codex-lsp-bridge:post-tool-diagnostics"), "install did not write PostToolUse hook");
assert(agents.includes("BEGIN codex-lsp-bridge"), "install did not write AGENTS instructions");

run(["scripts/uninstall-codex.mjs"]);

assert(!read("config.toml").includes("[mcp_servers.codex-lsp-bridge]"), "uninstall left MCP config behind");
assert(!read("hooks.json").includes("codex-lsp-bridge:post-tool-diagnostics"), "uninstall left hook behind");
assert(!read("AGENTS.md").includes("BEGIN codex-lsp-bridge"), "uninstall left AGENTS instructions behind");

run(["scripts/install-codex.mjs", "--auto-update", "--package", "codex-lsp-bridge@0.0.0-smoke"]);

const autoConfig = read("config.toml");
const autoHooks = read("hooks.json");
assert(autoConfig.includes('command = "npm"'), "auto-update install did not use npm command");
assert(autoConfig.includes('"--package=codex-lsp-bridge@0.0.0-smoke"'), "auto-update install did not preserve package spec");
assert(autoHooks.includes("npm exec --yes --package='codex-lsp-bridge@0.0.0-smoke' -- codex-lsp-bridge post-tool-diagnostics"), "auto-update hook did not use npm package spec");

const rustDryRun = run(["scripts/install-codex.mjs", "--dry-run", "--with-rust-analyzer"]);
assert(rustDryRun.stdout.includes("would install rust-analyzer"), "with-rust-analyzer dry run did not report rustup action");

fs.rmSync(codexHome, { recursive: true, force: true });
console.log("[codex-lsp-bridge] install/uninstall smoke passed");

function run(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: packageRoot,
    env,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.stderr.write(result.stdout);
    process.exit(result.status ?? 1);
  }
  return result;
}

function read(relativePath) {
  const filePath = path.join(codexHome, relativePath);
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
